import { Readable } from "node:stream";

function extractGeminiText(response: any): string {
  return (
    response?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("") ?? ""
  );
}

export function openAIStreamChunk(id: string, model: string, content: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null
      }
    ]
  };
}

export function openAIStreamDoneChunk(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop"
      }
    ]
  };
}

export async function* geminiSseToOpenAISse(response: Response, id: string, model: string): AsyncGenerator<string> {
  if (!response.body) {
    yield `data: ${JSON.stringify(openAIStreamDoneChunk(id, model))}\n\n`;
    yield "data: [DONE]\n\n";
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(payload);
        const text = extractGeminiText(parsed);
        if (text) {
          yield `data: ${JSON.stringify(openAIStreamChunk(id, model, text))}\n\n`;
        }
      }
    }
  }

  yield `data: ${JSON.stringify(openAIStreamDoneChunk(id, model))}\n\n`;
  yield "data: [DONE]\n\n";
}

export function readableFromOpenAIStream(response: Response, id: string, model: string): Readable {
  return Readable.from(geminiSseToOpenAISse(response, id, model));
}
