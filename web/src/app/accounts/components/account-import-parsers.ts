import type { AccountImportPayload } from "@/lib/api";

export const SUB2API_PLATFORM = "openai";

export type Sub2ApiParseResult = {
  accounts: AccountImportPayload[];
  skippedPlatform: number;
  skippedNoToken: number;
};

const EMPTY_SUB2API_RESULT: Sub2ApiParseResult = { accounts: [], skippedPlatform: 0, skippedNoToken: 0 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function splitTokens(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getSessionAccessToken(value: unknown) {
  const token = (value as { accessToken?: unknown })?.accessToken;
  return typeof token === "string" ? token.trim() : "";
}

export function getAccountJsonAccount(value: unknown): AccountImportPayload | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const raw = value;
  const credentials = isPlainObject(raw.credentials) ? raw.credentials : null;
  const tokenValue = raw.access_token ?? raw.accessToken ?? credentials?.access_token ?? credentials?.accessToken;
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!token) {
    return null;
  }

  if (credentials) {
    const extra = isPlainObject(raw.extra) ? raw.extra : {};
    const payload: AccountImportPayload = {
      ...credentials,
      access_token: token,
      export_type: "codex",
      source_type: "codex",
    };
    delete payload.accessToken;

    if (!payload.email && typeof extra.email === "string") {
      payload.email = extra.email;
    }
    if (!payload.last_refresh && typeof extra.last_refresh === "string") {
      payload.last_refresh = extra.last_refresh;
    }
    if (typeof raw.name === "string" && raw.name.trim()) {
      payload.name = raw.name;
    }
    if (typeof raw.platform === "string" && raw.platform.trim()) {
      payload.sub2api_platform = raw.platform;
    }
    if (typeof raw.type === "string" && raw.type.trim()) {
      payload.sub2api_auth_type = raw.type;
    }
    if (typeof raw.concurrency === "number") {
      payload.concurrency = raw.concurrency;
    }
    if (typeof raw.priority === "number") {
      payload.priority = raw.priority;
    }
    return payload;
  }

  const payload: AccountImportPayload = {
    ...raw,
    access_token: token,
    source_type: "codex",
  };
  delete payload.accessToken;
  if (payload.type === "codex") {
    payload.export_type = "codex";
    delete payload.type;
  }
  return payload;
}

export function getAccountJsonAccounts(value: unknown): AccountImportPayload[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => getAccountJsonAccount(item))
      .filter((item): item is AccountImportPayload => Boolean(item));
  }

  const singleAccount = getAccountJsonAccount(value);
  if (singleAccount) {
    return [singleAccount];
  }

  if (isPlainObject(value)) {
    const nested = value.accounts ?? value.items;
    if (Array.isArray(nested)) {
      return nested
        .map((item) => getAccountJsonAccount(item))
        .filter((item): item is AccountImportPayload => Boolean(item));
    }
  }

  return [];
}

export function getCodexAuthAccount(value: unknown): AccountImportPayload | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const raw = value;
  const tokenValue = raw.access_token ?? raw.accessToken;
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!token) {
    return null;
  }

  const payload: AccountImportPayload = {
    ...raw,
    access_token: token,
    export_type: "codex",
    source_type: "codex",
  };
  delete payload.accessToken;
  if (payload.type === "codex") {
    delete payload.type;
  }
  return payload;
}

/**
 * Pull the account list out of a Sub2API export. The exported file wraps accounts in
 * `{ accounts, proxies, exported_at }`; the admin API wraps the same list in `{ code, data }`.
 * A bare array or a single account object is accepted too.
 */
function getSub2ApiAccountItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isPlainObject);
  }
  if (!isPlainObject(value)) {
    return [];
  }

  for (const source of [value, isPlainObject(value.data) ? value.data : null]) {
    if (!source) {
      continue;
    }
    for (const key of ["accounts", "items", "list"]) {
      const nested = source[key];
      if (Array.isArray(nested)) {
        return nested.filter(isPlainObject);
      }
    }
  }

  return isPlainObject(value.credentials) ? [value] : [];
}

export function parseSub2ApiExport(value: unknown): Sub2ApiParseResult {
  const result: Sub2ApiParseResult = { accounts: [], skippedPlatform: 0, skippedNoToken: 0 };

  for (const item of getSub2ApiAccountItems(value)) {
    // Sub2API pools can also hold Claude/Gemini accounts, which are useless here.
    const platform = typeof item.platform === "string" ? item.platform.trim().toLowerCase() : "";
    if (platform && platform !== SUB2API_PLATFORM) {
      result.skippedPlatform += 1;
      continue;
    }
    // Reuses the account-json normalizer so credentials are flattened the same way.
    const account = getAccountJsonAccount(item);
    if (!account) {
      result.skippedNoToken += 1;
      continue;
    }
    result.accounts.push(account);
  }

  return result;
}

export function mergeSub2ApiResults(results: Sub2ApiParseResult[]): Sub2ApiParseResult {
  const byToken = new Map<string, AccountImportPayload>();
  let skippedPlatform = 0;
  let skippedNoToken = 0;

  for (const result of results) {
    skippedPlatform += result.skippedPlatform;
    skippedNoToken += result.skippedNoToken;
    for (const account of result.accounts) {
      byToken.set(account.access_token, account);
    }
  }

  return { accounts: Array.from(byToken.values()), skippedPlatform, skippedNoToken };
}

export function parseSub2ApiText(value: string): Sub2ApiParseResult {
  if (!value.trim()) {
    return EMPTY_SUB2API_RESULT;
  }
  try {
    return parseSub2ApiExport(JSON.parse(value) as unknown);
  } catch {
    return EMPTY_SUB2API_RESULT;
  }
}

export function describeSub2ApiSkips(result: Pick<Sub2ApiParseResult, "skippedPlatform" | "skippedNoToken">) {
  const parts: string[] = [];
  if (result.skippedPlatform > 0) {
    parts.push(`跳过 ${result.skippedPlatform} 个非 OpenAI 平台账号`);
  }
  if (result.skippedNoToken > 0) {
    parts.push(`跳过 ${result.skippedNoToken} 个缺少 access_token 的账号`);
  }
  return parts.join("，");
}
