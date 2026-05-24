declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  function generate(text: string, opts?: Options, callback?: (qr: string) => void): void;
  export default { generate };
}
