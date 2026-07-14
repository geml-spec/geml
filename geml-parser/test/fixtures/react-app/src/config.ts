// Negative control: a plain object-literal const is data, not a component —
// it must never surface as a Function node in the codemap.
export const appConfig = {
  appName: "react-fixture",
  version: "0.1.0",
};
