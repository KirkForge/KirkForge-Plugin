import { ok, err, type Result } from "@55ndeep/core-types";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// SecretsProvider interface
// ---------------------------------------------------------------------------

/**
 * Abstract secrets resolution. Each provider maps string keys to secret values.
 * Providers are tried in priority order; the first non-null result wins.
 */
export interface SecretsProvider {
  /** Human-readable name for logging/debugging. */
  readonly name: string;
  /** Resolve a secret by key. Returns null if the key is unknown to this provider. */
  get(key: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// SecretsManager — chains multiple providers
// ---------------------------------------------------------------------------

export class SecretsManager {
  private providers: SecretsProvider[];

  constructor(providers: SecretsProvider[]) {
    this.providers = providers;
  }

  /**
   * Resolve a secret key across all providers in priority order.
   * Returns the first non-null result, or null if no provider knows the key.
   */
  async get(key: string): Promise<string | null> {
    for (const p of this.providers) {
      try {
        const value = await p.get(key);
        if (value !== null) return value;
      } catch {
        // Provider failed — skip to next
      }
    }
    return null;
  }

  /**
   * Resolve a required secret. Returns err if no provider returns a value.
   */
  async require(key: string): Promise<Result<string, Error>> {
    const value = await this.get(key);
    if (value === null) {
      return err(new Error(`Secret "${key}" not found in any provider`));
    }
    return ok(value);
  }
}

// ---------------------------------------------------------------------------
// EnvSecretsProvider — reads from environment variables
// ---------------------------------------------------------------------------

export class EnvSecretsProvider implements SecretsProvider {
  readonly name = "env";
  private env: Record<string, string | undefined>;

  constructor(env?: Record<string, string | undefined>) {
    this.env = env ?? (process.env as Record<string, string | undefined>);
  }

  async get(key: string): Promise<string | null> {
    return this.env[key] ?? null;
  }
}

// ---------------------------------------------------------------------------
// VaultSecretsProvider — HashiCorp Vault KV v2
// ---------------------------------------------------------------------------

export interface VaultConfig {
  /** Vault server URL (e.g. https://vault.example.com:8200). */
  address: string;
  /** Vault token for authentication. */
  token: string;
  /** KV v2 mount path (default: "secret"). */
  mount?: string;
  /** Key path prefix to prepend to all lookups. */
  prefix?: string;
}

export class VaultSecretsProvider implements SecretsProvider {
  readonly name = "vault";
  private config: Required<VaultConfig>;

  constructor(config: VaultConfig) {
    this.config = {
      address: config.address.replace(/\/$/, ""),
      token: config.token,
      mount: config.mount ?? "secret",
      prefix: config.prefix ?? "",
    };
  }

  async get(key: string): Promise<string | null> {
    const fullPath = this.config.prefix ? `${this.config.prefix}/${key}` : key;
    // KV v2: encode each path segment separately, preserving / as path separators
    const encodedPath = fullPath
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const url = `${this.config.address}/v1/${this.config.mount}/data/${encodedPath}`;

    try {
      const res = await fetch(url, {
        headers: { "X-Vault-Token": this.config.token },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { data?: Record<string, string> };
      };
      const secretData = body?.data?.data;
      if (!secretData) return null;

      // Vault KV v2 stores key-value pairs. Try direct key lookup first,
      // then fall back to "value" field convention.
      if (typeof secretData[key] === "string") return secretData[key]!;
      if (typeof secretData.value === "string") return secretData.value;
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// AWS SigV4 helpers (used by AwsSecretsProvider)
// ---------------------------------------------------------------------------

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export interface SigV4SignOptions {
  method: string;
  host: string;
  region: string;
  service: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO-8601 timestamp override for deterministic testing. */
  now?: Date;
  /** Canonical URI override (default "/"). */
  canonicalUri?: string;
  /** Canonical query override (default ""). */
  canonicalQuery?: string;
  /** Content type override (default "application/x-amz-json-1.1"). */
  contentType?: string;
  /** X-Amz-Target override (default "secretsmanager.GetSecretValue"). */
  target?: string;
}

export function awsSigV4Sign(opts: SigV4SignOptions): { headers: Record<string, string> } {
  const now = opts.now ?? new Date();
  const amzDate =
    now
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = opts.canonicalUri ?? "/";
  const canonicalQuery = opts.canonicalQuery ?? "";
  const payloadHash = sha256Hex(opts.body);
  const contentType = opts.contentType ?? "application/x-amz-json-1.1";
  const target = opts.target ?? "secretsmanager.GetSecretValue";

  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${opts.host}`,
    `x-amz-date:${amzDate}`,
  ];
  if (target) {
    canonicalHeaders.push(`x-amz-target:${target}`);
  }
  if (opts.sessionToken) {
    canonicalHeaders.push(`x-amz-security-token:${opts.sessionToken}`);
  }
  canonicalHeaders.sort();
  const canonicalHeadersStr = canonicalHeaders.join("\n") + "\n";
  const signedHeaders = canonicalHeaders.map((h) => h.split(":")[0]!).join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeadersStr,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const kDate = hmacSha256("AWS4" + opts.secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, opts.region);
  const kService = hmacSha256(kRegion, opts.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Host: opts.host,
    "X-Amz-Date": amzDate,
    Authorization: authorization,
  };
  if (target) {
    headers["X-Amz-Target"] = target;
  }
  if (opts.sessionToken) {
    headers["X-Amz-Security-Token"] = opts.sessionToken;
  }

  return { headers };
}
// ---------------------------------------------------------------------------
// AwsSecretsProvider — AWS Secrets Manager (with SigV4 signing)
// ---------------------------------------------------------------------------

export interface AwsSecretsConfig {
  /** AWS region. */
  region: string;
  /** Optional explicit credentials. Falls back to default credential chain. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export class AwsSecretsProvider implements SecretsProvider {
  readonly name = "aws-secrets-manager";
  private config: AwsSecretsConfig;

  constructor(config: AwsSecretsConfig) {
    this.config = config;
  }

  async get(key: string): Promise<string | null> {
    // Without explicit credentials, AWS requests can't be signed.
    // Fall back to the default credential chain via process.env or
    // return null so the chain moves to the next provider.
    const accessKeyId = this.config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = this.config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = this.config.sessionToken ?? process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
      // No credentials available — skip this provider so the chain
      // can fall through to GCP or env vars.
      return null;
    }

    try {
      const host = `secretsmanager.${this.config.region}.amazonaws.com`;
      const url = `https://${host}/`;
      const body = JSON.stringify({ SecretId: key });

      const { headers } = awsSigV4Sign({
        method: "POST",
        host,
        region: this.config.region,
        service: "secretsmanager",
        body,
        accessKeyId,
        secretAccessKey,
        sessionToken: sessionToken ?? undefined,
      });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        SecretString?: string;
        SecretBinary?: string;
      };

      if (data.SecretString) {
        // Try JSON first (key-value pairs), then plain string
        try {
          const kv = JSON.parse(data.SecretString) as Record<string, string>;
          if (typeof kv[key] === "string") return kv[key]!;
          if (typeof kv.value === "string") return kv.value;
        } catch {
          return data.SecretString;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// GcpSecretsProvider — Google Cloud Secret Manager
// ---------------------------------------------------------------------------

export interface GcpSecretsConfig {
  /** GCP project ID. */
  projectId: string;
  /** Service account access token or path to credentials file. */
  accessToken?: string;
  credentialsFile?: string;
}

export class GcpSecretsProvider implements SecretsProvider {
  readonly name = "gcp-secret-manager";
  private config: GcpSecretsConfig;
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: GcpSecretsConfig) {
    this.config = config;
  }

  private async resolveAccessToken(): Promise<string | null> {
    // Use explicit access token if provided
    if (this.config.accessToken) return this.config.accessToken;

    // Check cached token
    if (this.cachedToken && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }

    // Try loading from credentials file
    const credsPath = this.config.credentialsFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credsPath && existsSync(credsPath)) {
      try {
        const credsRaw = readFileSync(credsPath, "utf-8");
        const creds = JSON.parse(credsRaw) as {
          client_email?: string;
          private_key?: string;
          token_uri?: string;
        };

        if (creds.client_email && creds.private_key && creds.token_uri) {
          const token = await this.mintJwtAccessToken(
            creds.client_email,
            creds.private_key,
            creds.token_uri,
          );
          if (token) {
            this.cachedToken = token.access_token;
            this.tokenExpiry = Date.now() + (token.expires_in ?? 3600) * 1000 - 60000;
            return this.cachedToken;
          }
        }
      } catch {
        // Credentials file parse failed — try next method
      }
    }

    return null;
  }

  private async mintJwtAccessToken(
    clientEmail: string,
    privateKey: string,
    tokenUri: string,
  ): Promise<{ access_token: string; expires_in: number } | null> {
    try {
      // Create a self-signed JWT for service account authentication
      const header = { alg: "RS256", typ: "JWT" };
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: clientEmail,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: tokenUri,
        exp: now + 3600,
        iat: now,
      };

      const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const claimsB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const unsigned = `${headerB64}.${claimsB64}`;

      const { createSign } = await import("node:crypto");
      const sign = createSign("RSA-SHA256");
      sign.update(unsigned);
      const signature = sign.sign(privateKey, "base64url");
      const jwt = `${unsigned}.${signature}`;

      const res = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return null;
      return (await res.json()) as { access_token: string; expires_in: number };
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      const accessToken = await this.resolveAccessToken();
      if (!accessToken) return null;

      const projectId = this.config.projectId;
      const secretName = `projects/${projectId}/secrets/${key}/versions/latest`;
      const url = `https://secretmanager.googleapis.com/v1/${secretName}:access`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      };

      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        payload?: { data?: string };
      };

      if (data.payload?.data) {
        // GCP returns base64-encoded secret data
        return Buffer.from(data.payload.data, "base64").toString("utf-8");
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a SecretsManager from environment variables.
 * Detects which providers are configured and chains them in order:
 * 1. Vault (if VAULT_ADDR + VAULT_TOKEN set)
 * 2. AWS (if AWS_REGION set)
 * 3. GCP (if GCP_PROJECT_ID set)
 * 4. Env vars (always last as fallback)
 */
export function createSecretsManager(env?: Record<string, string | undefined>): SecretsManager {
  const e = env ?? (process.env as Record<string, string | undefined>);
  const providers: SecretsProvider[] = [];

  // Vault
  if (e.VAULT_ADDR && e.VAULT_TOKEN) {
    providers.push(
      new VaultSecretsProvider({
        address: e.VAULT_ADDR,
        token: e.VAULT_TOKEN,
        mount: e.VAULT_MOUNT,
        prefix: e.VAULT_SECRET_PREFIX,
      }),
    );
  }

  // AWS — only activate when both region and credentials are present
  if (e.AWS_REGION && e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) {
    providers.push(
      new AwsSecretsProvider({
        region: e.AWS_REGION,
        accessKeyId: e.AWS_ACCESS_KEY_ID,
        secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
        sessionToken: e.AWS_SESSION_TOKEN,
      }),
    );
  }

  // GCP — only activate when project and credentials (token or key file) are present
  if (e.GCP_PROJECT_ID && (e.GCP_ACCESS_TOKEN || e.GOOGLE_APPLICATION_CREDENTIALS)) {
    providers.push(
      new GcpSecretsProvider({
        projectId: e.GCP_PROJECT_ID,
        accessToken: e.GCP_ACCESS_TOKEN,
        credentialsFile: e.GOOGLE_APPLICATION_CREDENTIALS,
      }),
    );
  }

  // Env vars (always last)
  providers.push(new EnvSecretsProvider(e));

  return new SecretsManager(providers);
}

// ---------------------------------------------------------------------------
// Secret redaction — prevent secrets from leaking into logs, errors, traces
// ---------------------------------------------------------------------------

/**
 * Patterns that match common secret/key formats in strings.
 * These are intentionally broad to catch common secret shapes without
 * false positives on short random strings.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // AWS access key IDs (AKIA...)
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "aws_access_key_id" },
  // AWS secret access keys (40-char base64-ish after known prefix)
  { pattern: /\b[A-Za-z0-9/+=]{40}\b/g, label: "aws_secret_access_key" },
  // Generic API key patterns: key=xxx, api_key=xxx, apikey=xxx, token=xxx
  {
    pattern:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|auth[_-]?token|bearer[_-]?token|private[_-]?key)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{8,})["']?/gi,
    label: "api_key_value",
  },
  // Bearer tokens in Authorization headers
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, label: "bearer_token" },
  // Vault tokens (s.xxxxx or hvs.xxxxx)
  { pattern: /(?:s\.|hvs\.)[A-Za-z0-9]{24}/g, label: "vault_token" },
  // Connection strings with passwords
  { pattern: /:\/\/([^:]+):([^@]+)@/g, label: "connection_string_password" },
  // Private key blocks
  {
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    label: "private_key",
  },
  // JWT tokens (three base64url segments separated by dots)
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, label: "jwt" },
  // Generic long hex strings (32+ chars that look like tokens/keys)
  { pattern: /\b[0-9a-fA-F]{32,}\b/g, label: "hex_secret" },
  // Environment variable assignments for common secret names
  {
    pattern:
      /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
    label: "env_secret",
  },
];

/**
 * Redact secrets from a string, replacing matches with [REDACTED_label].
 *
 * This is used to sanitize logs, error messages, audit trails, and tool output
 * before they are persisted or transmitted.
 *
 * @param input - The string to redact.
 * @param options - Optional overrides for which labels to redact and replacement text.
 * @returns The redacted string.
 */
export function redactSecrets(
  input: string,
  options?: {
    /** Specific labels to redact. If omitted, all patterns are applied. */
    labels?: string[];
    /** Replacement text format. Default: "[REDACTED_{label}]". */
    replacement?: (label: string) => string;
  },
): string {
  const labels = options?.labels;
  const replacement = options?.replacement ?? ((label: string) => `[REDACTED_${label}]`);

  let result = input;
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (labels && !labels.includes(label)) continue;
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, (_match) => replacement(label));
  }
  return result;
}

/**
 * Redact secrets from an arbitrary JSON-serializable value.
 * Recursively walks objects and arrays, redacting all string values.
 *
 * @param value - The value to redact.
 * @param options - Same options as redactSecrets.
 * @returns A deep copy of the value with secrets redacted.
 */
export function redactSecretsDeep(
  value: unknown,
  options?: Parameters<typeof redactSecrets>[1],
): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, options));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // Also redact values whose keys look like secret names
      if (
        typeof val === "string" &&
        /(?:password|secret|token|key|auth|credential|private)/i.test(key)
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSecretsDeep(val, options);
      }
    }
    return result;
  }
  return value;
}
