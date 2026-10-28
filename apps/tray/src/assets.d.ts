// files imported with type file: their path on disk or inside the compiled binary
declare module "*.png" { const path: string; export default path; }
declare module "*.ico" { const path: string; export default path; }
declare module "*.html" { const path: string; export default path; }
