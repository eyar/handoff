import "./jsQR.js";

const jsQR = typeof self !== "undefined" && self.jsQR ? self.jsQR : (typeof window !== "undefined" ? window.jsQR : null);
export default jsQR;
export { jsQR };
