// esbuild loads .css with the `text` loader; tell TypeScript it's a string.
declare module "*.css" {
  const css: string;
  export default css;
}
