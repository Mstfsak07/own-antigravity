import type { HealthState, StoredAccount } from "./types.js";

export type AccountDiagnosis = {
  isProblem: boolean;
  kind:
    | "healthy"
    | "manual_disabled"
    | "auth_expired"
    | "auth_failed"
    | "rate_limited"
    | "provider_failure"
    | "quarantined"
    | "unknown";
  title: string;
  reason: string;
  recommendation: string;
  steps: string[];
  canDisable: boolean;
  disableReason?: string;
};

type ProblemDiagnosis = Omit<AccountDiagnosis, "isProblem" | "kind" | "canDisable">;

function disabledReasonValue(health: HealthState | undefined): string {
  return String(health?.disabledReason || "").toLowerCase();
}

function hasFutureRetry(health: HealthState | undefined, now = Date.now()): boolean {
  if (!health?.nextRetryAt) return false;
  const retryAt = Date.parse(health.nextRetryAt);
  return Number.isFinite(retryAt) && retryAt > now;
}

function isExpired(account: StoredAccount, now = Date.now()): boolean {
  return Boolean(account.expiresAt && account.expiresAt * 1000 <= now);
}

function oauthRecoverySteps(account: StoredAccount): string[] {
  const email = account.email || "hesap e-postası";
  return [
    "Uygulamada hesabı kaldırıp yeniden OAuth ile ekle.",
    `OAuth ekranında aynı hesabı seç: ${email}.`,
    `Bu hesap \`gcloud auth list\` içinde görünüyorsa isteğe bağlı olarak \`gcloud auth revoke ${email}\` çalıştır.`
  ];
}

function importedRecoverySteps(account: StoredAccount): string[] {
  if (account.source === "manual_refresh_token") {
    return [
      "Geçerli bir refresh token üret.",
      "Hesabı kaldırıp yeni refresh token ile tekrar içe aktar.",
      "Gerekirse OAuth client / izin kapsamlarını yeniden doğrula."
    ];
  }
  return [
    "Kaynak JSON içindeki access/refresh token çiftini yenile.",
    "Hesabı kaldırıp güncel JSON ile tekrar içe aktar.",
    "Google tarafında hesap erişimi iptal edildiyse yeniden yetkilendir."
  ];
}

function authSteps(account: StoredAccount): string[] {
  return account.source === "oauth_login" ? oauthRecoverySteps(account) : importedRecoverySteps(account);
}

function authFailureDiagnosis(account: StoredAccount, expired: boolean): ProblemDiagnosis {
  return {
    title: expired ? "Oturum süresi dolmuş" : "Kimlik doğrulama hatası",
    reason: expired
      ? "Access token süresi geçmiş ve hesap artık geçerli oturumla çağrı yapamıyor."
      : "Upstream bu hesabı geçerli kimlik bilgisi olarak kabul etmiyor.",
    recommendation: "Bu hesabı devre dışı bırak ve yeniden yetkilendir.",
    steps: authSteps(account),
    disableReason: "manual:auth_error"
  };
}

function rateLimitDiagnosis(): ProblemDiagnosis {
  return {
    title: "Rate limit / kota sınırı",
    reason: "Bu hesap kota veya hız limiti nedeniyle geçici olarak başarısız oluyor.",
    recommendation: "Şimdilik devre dışı bırakmak yerine dinlendir; kota resetinden sonra tekrar aç.",
    steps: [
      "Reset zamanını veya yeniden deneme penceresini bekle.",
      "Aynı model için daha yüksek kotalı hesapları kullan.",
      "Sık tekrar ediyorsa hesabı geçici olarak devre dışı bırak."
    ],
    disableReason: "manual:http_429"
  };
}

function providerFailureDiagnosis(): ProblemDiagnosis {
  return {
    title: "Upstream internal hata",
    reason: "Hesap geçerli görünüyor ama Cloud Code / upstream bu hesapta 500 benzeri internal hata döndürüyor.",
    recommendation: "Hesabı rotasyondan çıkar, bir süre dinlendir ve sonra tekrar dene.",
    steps: [
      "Hesabı devre dışı bırakıp diğer hesapların kullanılmasına izin ver.",
      "Aynı hesap uzun süre 500 veriyorsa hesabı kaldırıp yeniden yetkilendir.",
      "Google Console / Cloud Code tarafında kısıtlama veya risk kontrolü olup olmadığını kontrol et."
    ],
    disableReason: "manual:http_500"
  };
}

function unstableDiagnosis(retrying: boolean): ProblemDiagnosis {
  return {
    title: retrying ? "Geçici karantina" : "Kararsız hesap",
    reason: retrying
      ? "Hesap hata sonrası yeniden deneme penceresinde bekliyor."
      : "Hesap son çağrılarda ardışık hata ürettiği için güvenilir değil.",
    recommendation: "Tekrar eden hatalar sürerse devre dışı bırakıp yeniden doğrula.",
    steps: [
      "Son hata sebebini incele.",
      "Gerekirse hesabı yenile veya yeniden yetkilendir.",
      "Sorun tekrarlıyorsa hesabı devre dışı bırak."
    ],
    disableReason: "manual:unstable"
  };
}

function diagnosisFromReason(account: StoredAccount, reason: string, expired: boolean, retrying: boolean): ProblemDiagnosis | undefined {
  if (reason === "auth_error" || reason === "http_401" || reason === "http_403" || expired) {
    return authFailureDiagnosis(account, expired);
  }
  if (reason === "rate_limit" || reason === "http_429") {
    return rateLimitDiagnosis();
  }
  if (reason === "provider_error" || reason === "http_500" || reason === "http_503") {
    return providerFailureDiagnosis();
  }
  if (retrying || account.health?.healthy === false || Number(account.health?.consecutiveFailures || 0) > 0) {
    return unstableDiagnosis(retrying);
  }
  return undefined;
}

export function diagnoseAccount(account: StoredAccount, now = Date.now()): AccountDiagnosis {
  const reason = disabledReasonValue(account.health);
  const retrying = hasFutureRetry(account.health, now);
  const expired = isExpired(account, now);
  const failures = Number(account.health?.consecutiveFailures || 0);
  const manuallyDisabled = account.status === "disabled" && (reason === "disabled" || reason.startsWith("manual_") || reason.startsWith("manual:"));
  const preservedReason = reason.startsWith("manual:") ? reason.slice("manual:".length) : reason;

  if (manuallyDisabled) {
    const original = preservedReason && preservedReason !== "disabled" ? preservedReason : undefined;
    const preservedDiagnosis = original ? diagnosisFromReason(account, original, expired, retrying) : undefined;
    return {
      isProblem: true,
      kind: "manual_disabled",
      title: preservedDiagnosis ? `${preservedDiagnosis.title} (pasife alındı)` : "Manuel devre dışı",
      reason: preservedDiagnosis
        ? `Hesap kullanıcı tarafından devre dışı bırakıldı. ${preservedDiagnosis.reason}`
        : original
          ? `Hesap kullanıcı tarafından devre dışı bırakıldı. Son bilinen kök neden: ${original}.`
          : "Hesap kullanıcı tarafından devre dışı bırakıldı.",
      recommendation: preservedDiagnosis
        ? `${preservedDiagnosis.recommendation} Sorunu çözdükten sonra hesabı yeniden etkinleştir.`
        : "Gerekmiyorsa kapalı bırak. Yeniden kullanacaksan önce kök nedeni düzelt, sonra etkinleştir.",
      steps: preservedDiagnosis
        ? [...preservedDiagnosis.steps, "Sorun çözüldüğünde hesap kartından yeniden etkinleştir."]
        : [
            "Sorun auth ise hesabı yeniden yetkilendir.",
            "Sorun 500/429 ise hesabı bir süre dinlendirip sonra tekrar etkinleştir.",
            "Hazır olduğunda hesap kartından yeniden etkinleştir."
          ],
      canDisable: false
    };
  }

  if (reason === "auth_error" || reason === "http_401" || reason === "http_403" || expired) {
    const diagnosis = authFailureDiagnosis(account, expired);
    return {
      isProblem: true,
      kind: expired ? "auth_expired" : "auth_failed",
      title: diagnosis.title,
      reason: diagnosis.reason,
      recommendation: diagnosis.recommendation,
      steps: diagnosis.steps,
      canDisable: true,
      disableReason: diagnosis.disableReason
    };
  }

  if (reason === "rate_limit" || reason === "http_429") {
    const diagnosis = rateLimitDiagnosis();
    return {
      isProblem: true,
      kind: "rate_limited",
      title: diagnosis.title,
      reason: diagnosis.reason,
      recommendation: diagnosis.recommendation,
      steps: diagnosis.steps,
      canDisable: true,
      disableReason: diagnosis.disableReason
    };
  }

  if (reason === "provider_error" || reason === "http_500" || reason === "http_503") {
    const diagnosis = providerFailureDiagnosis();
    return {
      isProblem: true,
      kind: "provider_failure",
      title: diagnosis.title,
      reason: diagnosis.reason,
      recommendation: diagnosis.recommendation,
      steps: diagnosis.steps,
      canDisable: true,
      disableReason: diagnosis.disableReason
    };
  }

  if (retrying || failures > 0 || account.health?.healthy === false) {
    const diagnosis = unstableDiagnosis(retrying);
    return {
      isProblem: true,
      kind: retrying ? "quarantined" : "unknown",
      title: diagnosis.title,
      reason: diagnosis.reason,
      recommendation: diagnosis.recommendation,
      steps: diagnosis.steps,
      canDisable: true,
      disableReason: diagnosis.disableReason
    };
  }

  return {
    isProblem: false,
    kind: "healthy",
    title: "Sağlıklı",
    reason: "Son verilere göre hesap kullanılabilir durumda.",
    recommendation: "Ek işlem gerekmiyor.",
    steps: [],
    canDisable: false
  };
}
