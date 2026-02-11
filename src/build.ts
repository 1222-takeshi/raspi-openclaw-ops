export type BuildInfo = {
  version: string;
  gitRef: string | null;
  gitSha: string | null;
  buildTime: string | null;
};

type Env = Record<string, string | undefined>;

export function getBuildInfo(env: Env, versionFromPackage: string): BuildInfo {
  const version = (env.APP_VERSION ?? versionFromPackage ?? '').trim() || 'unknown';
  const gitRef = (env.GIT_REF ?? '').trim() || null;
  const gitSha = (env.GIT_SHA ?? '').trim() || null;
  const buildTime = (env.BUILD_TIME ?? '').trim() || null;
  return { version, gitRef, gitSha, buildTime };
}
