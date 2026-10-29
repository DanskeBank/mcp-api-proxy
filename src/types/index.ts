export type Tier = "mock" | "sandbox" | "live";

export interface EnvironmentAuth {
  /** Path to PEM-encoded x509 client certificate */
  certPath: string;
  /** Path to PEM-encoded private key (may be encrypted) */
  keyPath: string;
  /** Optional passphrase if the private key file is encrypted */
  keyPassphrase?: string;
  /** OAuth2 token endpoint for this environment/tier */
  tokenUrl: string;
}

export interface ExecuteParams {
  method: string;
  url: string;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Selected API tier — drives auth dispatcher + Authorization header. */
  tier: Tier;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
