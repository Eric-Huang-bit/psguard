export class ShellNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellNotFoundError";
  }
}
