export const BUILTIN_COVERS: Record<string, string> = {
  'halo-sigs/plugin-moments': '/covers/halo-moments.png',
  'halo-sigs/plugin-photos': '/covers/halo-photos.png',
  'halo-sigs/plugin-links': '/covers/halo-links.png',
  'halo-dev/plugin-mcp-server': '/covers/halo-mcp.png',
  'halo-dev/plugin-s3': '/covers/halo-s3.png',
  'halo-dev/halo': '/covers/halo.png',
  'spring-projects/spring-modulith': '/covers/spring-modulith.png',
  'spring-projects/spring-boot': '/covers/spring-boot.png',
  'spring-projects/spring-grpc': '/covers/spring-grpc.png',
  'spring-projects/spring-ai': '/covers/spring-ai.png',
};

export function defaultCoverForRepo(repo: string): string | null {
  return BUILTIN_COVERS[repo.toLowerCase()] ?? null;
}
