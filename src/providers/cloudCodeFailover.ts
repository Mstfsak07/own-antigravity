import { callCloudCode } from "../cloudCode/client.js";
import { cloudCodeRecoveryModelCandidates } from "../cloudCode/accounts.js";
import { ensureCloudCodeProjectId } from "../cloudCode/quota.js";
import { classifyError, classifyStatus } from "../errors.js";
import type { Runtime } from "../runtime.js";
import type { CloudCodeAccount } from "../types.js";

export type CloudCodeRelayResult =
  | {
      ok: true;
      account: CloudCodeAccount;
      requestBody: Record<string, unknown>;
      response: Response;
    }
  | {
      ok: false;
      account?: CloudCodeAccount;
      requestBody?: Record<string, unknown>;
      response?: Response;
      error?: unknown;
    };

function shouldRetryCloudCode(status: number): boolean {
  return [401, 403, 404, 429, 500, 502, 503, 504].includes(status);
}

function shouldQuarantineCloudCodeAccount(status: number): boolean {
  return [401, 403, 408, 429, 504].includes(status);
}

function isTimeoutResponse(status: number, bodyText?: string): boolean {
  return status === 408 ||
    status === 504 ||
    Boolean(bodyText && /operation was aborted due to timeout|aborted due to timeout|timed out/i.test(bodyText));
}

function isProjectContextError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("configured to use a google cloud project") ||
    normalized.includes("lack a gemini code assist license") ||
    normalized.includes("gemini code assist license")
  );
}

function requiresProjectBootstrap(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("flash-image") ||
    normalized.startsWith("claude") ||
    normalized.startsWith("gemini") ||
    normalized.startsWith("gpt") ||
    normalized.startsWith("imagen")
  );
}

async function readResponseText(response: Response): Promise<string> {
  return response.clone().text().catch(() => "");
}

type RelayOptions = {
  runtime: Runtime;
  model: string;
  method: "generateContent" | "streamGenerateContent";
  search?: string;
  maxAttempts?: number;
  maxTimeoutAttempts?: number;
  initialAccount?: CloudCodeAccount;
  buildBody: (account: CloudCodeAccount, model: string) => Record<string, unknown>;
};

export async function callCloudCodeWithFailover(options: RelayOptions): Promise<CloudCodeRelayResult> {
  const { runtime, model, method, search, buildBody } = options;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const maxTimeoutAttempts = Math.max(1, Math.min(maxAttempts, options.maxTimeoutAttempts ?? 2));
  let lastFailure: CloudCodeRelayResult = { ok: false };
  let preferredAccount = options.initialAccount;
  const modelCandidates = [model, ...cloudCodeRecoveryModelCandidates(model)].filter((value, index, list) => list.indexOf(value) === index);

  for (const candidateModel of modelCandidates) {
    const excludedIds: string[] = [];
    let attempts = 0;
    let timeoutAttempts = 0;

    while (attempts < maxAttempts) {
      const account =
        preferredAccount && !excludedIds.includes(preferredAccount.id)
          ? preferredAccount
          : await runtime.cloudCodeAccounts.select(candidateModel, { excludeIds: excludedIds });
      preferredAccount = undefined;
      if (!account) {
        break;
      }

      let selectedAccount = account;
      if (requiresProjectBootstrap(candidateModel) && !selectedAccount.projectId) {
        try {
          const hydratedAccount = await ensureCloudCodeProjectId(runtime.config, selectedAccount);
          if (hydratedAccount.projectId && hydratedAccount.projectId !== selectedAccount.projectId) {
            runtime.cloudCodeAccounts.addOrUpdate(hydratedAccount);
            selectedAccount = hydratedAccount;
          }
        } catch {
          // Keep the original account if project bootstrap fails; upstream retry logic still applies.
        }
      }
      let requestBody = buildBody(selectedAccount, candidateModel);
      let response: Response | undefined;

      try {
        runtime.metrics.setActiveProvider("cloudCode");
        response = await callCloudCode(runtime.config, selectedAccount, method, requestBody, search);
      } catch (error) {
        const failureType = classifyError(error);
        runtime.cloudCodeAccounts.reportFailure(selectedAccount.id, failureType);
        runtime.cloudCodeAccounts.noteModelFailure(selectedAccount.id, candidateModel, failureType);
        runtime.metrics.recordProviderRequest("cloudCode", false);
        lastFailure = { ok: false, account: selectedAccount, requestBody, error };
        excludedIds.push(selectedAccount.id);
        attempts += 1;
        if (failureType === "timeout") {
          timeoutAttempts += 1;
          if (timeoutAttempts >= maxTimeoutAttempts) {
            break;
          }
        }
        continue;
      }

      if (response.status === 401 && selectedAccount.refreshToken) {
        const refreshed = await runtime.cloudCodeAccounts.refresh(selectedAccount);
        if (refreshed) {
          selectedAccount = refreshed;
          requestBody = buildBody(selectedAccount, candidateModel);
          try {
            runtime.metrics.setActiveProvider("cloudCode");
            response = await callCloudCode(runtime.config, selectedAccount, method, requestBody, search);
          } catch (error) {
            const failureType = classifyError(error);
            runtime.cloudCodeAccounts.reportFailure(selectedAccount.id, failureType);
            runtime.cloudCodeAccounts.noteModelFailure(selectedAccount.id, candidateModel, failureType);
            runtime.metrics.recordProviderRequest("cloudCode", false);
            lastFailure = { ok: false, account: selectedAccount, requestBody, error };
            excludedIds.push(selectedAccount.id);
            attempts += 1;
            if (failureType === "timeout") {
              timeoutAttempts += 1;
              if (timeoutAttempts >= maxTimeoutAttempts) {
                break;
              }
            }
            continue;
          }
        }
      }

      runtime.metrics.recordProviderRequest("cloudCode", response.ok);
      if (response.ok) {
        runtime.cloudCodeAccounts.reportSuccess(selectedAccount.id);
        runtime.cloudCodeAccounts.noteModelSuccess(selectedAccount.id, candidateModel);
        return {
          ok: true,
          account: selectedAccount,
          requestBody,
          response
        };
      }

      let errorText: string | undefined;
      const getErrorText = async () => {
        errorText ??= await readResponseText(response!);
        return errorText;
      };

      if (Object.prototype.hasOwnProperty.call(requestBody, "project")) {
        const projectErrorText = await getErrorText();
        if (isProjectContextError(projectErrorText)) {
          const retryBody = { ...requestBody };
          delete retryBody.project;
          selectedAccount = runtime.cloudCodeAccounts.clearProjectId(selectedAccount.id) ?? {
            ...selectedAccount,
            projectId: undefined
          };
          const retryResponse = await callCloudCode(runtime.config, selectedAccount, method, retryBody, search).catch((error) => {
            runtime.cloudCodeAccounts.reportFailure(selectedAccount.id, classifyError(error));
            runtime.cloudCodeAccounts.noteModelFailure(selectedAccount.id, candidateModel, classifyError(error));
            runtime.metrics.recordProviderRequest("cloudCode", false);
            lastFailure = { ok: false, account: selectedAccount, requestBody: retryBody, error };
            return undefined;
          });
          if (retryResponse) {
            runtime.metrics.recordProviderRequest("cloudCode", retryResponse.ok);
            if (retryResponse.ok) {
              runtime.cloudCodeAccounts.reportSuccess(selectedAccount.id);
              runtime.cloudCodeAccounts.noteModelSuccess(selectedAccount.id, candidateModel);
              return {
                ok: true,
                account: selectedAccount,
                requestBody: retryBody,
                response: retryResponse
              };
            }
            response = retryResponse;
            requestBody = retryBody;
          } else {
            excludedIds.push(selectedAccount.id);
            attempts += 1;
            continue;
          }
        }
      }

      const timeoutResponse = isTimeoutResponse(
        response.status,
        errorText ?? (response.status >= 500 || response.status === 408 ? await getErrorText() : undefined)
      );
      if (timeoutResponse) {
        runtime.cloudCodeAccounts.reportFailure(selectedAccount.id, "timeout");
      } else if (shouldQuarantineCloudCodeAccount(response.status)) {
        runtime.cloudCodeAccounts.reportStatusFailure(selectedAccount.id, response.status);
      }
      runtime.cloudCodeAccounts.noteModelFailure(selectedAccount.id, candidateModel, timeoutResponse ? "timeout" : response.status);
      lastFailure = {
        ok: false,
        account: selectedAccount,
        requestBody,
        response
      };
      excludedIds.push(selectedAccount.id);
      attempts += 1;
      if (timeoutResponse) {
        timeoutAttempts += 1;
        if (timeoutAttempts >= maxTimeoutAttempts) {
          break;
        }
      }

      if (!shouldRetryCloudCode(response.status)) {
        return lastFailure;
      }
    }
  }

  return lastFailure;
}
