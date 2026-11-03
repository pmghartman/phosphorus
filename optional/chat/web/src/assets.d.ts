// the stylesheet a module brings into the page, bundled by appbuild
declare module "*.css";
declare module "*.woff2" {
  const url: string;
  export default url;
}
