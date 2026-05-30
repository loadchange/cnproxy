/**
 * UI assets are imported as text (`with { type: "text" }`) so they embed into the compiled
 * single-file binary. These declarations type those imports as strings. More-specific patterns
 * than bun-types' ambient `*.html`, so they win for our `./ui/*` imports.
 */
declare module "*/ui/index.html" {
  const content: string;
  export default content;
}
declare module "*/ui/app.js" {
  const content: string;
  export default content;
}
declare module "*/ui/style.css" {
  const content: string;
  export default content;
}
