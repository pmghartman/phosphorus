// probe scripts bundled as text
declare module "*.ps1" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
