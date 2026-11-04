// file imports as paths, for tsc: bun hands them the embedded file's path
declare module "*.svg" {
  const path: string;
  export default path;
}
