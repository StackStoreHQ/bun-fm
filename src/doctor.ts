import { configSettings } from "./settings/config";

type ICheck = {
  name: string;
  run: () => Promise<void>;
};

const checks: ICheck[] = [];
const timeout = () => AbortSignal.timeout(15000);

async function readResponse(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) throw new Error("Empty response body");
  return Buffer.concat(chunks);
}

if (configSettings.llm.apiKey) {
  checks.push({
    name: "LLM",
    run: async () => {
      const response = await fetch(
        `${configSettings.llm.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configSettings.llm.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reasoning_effort: configSettings.llm.thinking,
            model: configSettings.llm.model,
            messages: [{ role: "user", content: "Reply OK" }],
            // Reasoning models spend some output tokens before producing content.
            max_tokens: 2048,
          }),
          signal: AbortSignal.timeout(90000),
        },
      );
      const body = await readResponse(response, 64 * 1024);
      let result: {
        choices?: {
          message?: { content?: unknown };
          finish_reason?: string;
        }[];
      };
      try {
        result = JSON.parse(body.toString("utf8")) as typeof result;
      } catch {
        throw new Error("Invalid JSON response");
      }
      const choice = result.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new Error("Generation stopped at token limit before completion");
      }
      const content = choice?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("No generated text in response");
      }
      console.log(`LLM returned: ${content.trim().slice(0, 120)}`);
    },
  });
}

if (configSettings.tts.apiKey) {
  checks.push({
    name: "TTS",
    run: async () => {
      const response = await fetch(
        `${configSettings.tts.baseUrl.replace(/\/+$/, "")}/audio/speech`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configSettings.tts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: configSettings.tts.model,
            voice: configSettings.tts.voice,
            input: "OK",
            response_format: configSettings.tts.format,
            speed: configSettings.tts.speed,
          }),
          signal: timeout(),
        },
      );
      const audio = await readResponse(response, 10 * 1024 * 1024);
      console.log(`TTS returned ${audio.length} bytes of audio`);
    },
  });
}

if (configSettings.telegram.botToken) {
  checks.push({
    name: "Telegram",
    run: async () => {
      const response = await fetch(
        `https://api.telegram.org/bot${configSettings.telegram.botToken}/getMe`,
        { signal: timeout() },
      );
      const body = await readResponse(response, 64 * 1024);
      let result: { ok?: boolean; result?: { username?: string } };
      try {
        result = JSON.parse(body.toString("utf8")) as typeof result;
      } catch {
        throw new Error("Invalid JSON response");
      }
      if (!result.ok) throw new Error("Telegram API reported failure");
      console.log(`Telegram bot: @${result.result?.username ?? "unknown"}`);
    },
  });
}

async function main() {
  console.log("Checking configured services...");
  if (checks.length === 0) {
    console.log("No services configured; nothing to check.");
    return;
  }

  const results = await Promise.all(
    checks.map(async ({ name, run }) => {
      try {
        await run();
        console.log(`${name}: check passed`);
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Unknown error";
        console.error(`${name}: failed (${detail})`);
        return false;
      }
    }),
  );

  if (results.some((success) => !success)) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("Doctor failed:", err);
  process.exitCode = 1;
});
