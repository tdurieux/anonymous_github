/** A resource connection, never a bearer credential. Missing means legacy OAuth. */
export interface RepositoryAccess {
  kind: "oauth" | "github-app";
  repositoryId?: number;
  /** App user access to a verified public repository, without an installation. */
  publicRead?: boolean;
  installationId?: number;
  revision: string;
}
