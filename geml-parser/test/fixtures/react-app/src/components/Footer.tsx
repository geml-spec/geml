import { memo } from "react";
import { appConfig } from "../config";

// memo()-wrapped component: the exported const is initialized with a CALL,
// not a function literal — probes whether HOC-wrapped components survive.
export const Footer = memo(function Footer() {
  return (
    <footer>
      {appConfig.appName} v{appConfig.version}
    </footer>
  );
});
