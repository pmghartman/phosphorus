// file imports as paths, for tsc: bun hands them the embedded file's path
declare module "*.md" {
  const path: string;
  export default path;
}
declare module "*.png" {
  const path: string;
  export default path;
}
