const CODE_PAGES: Record<number, string> = {
  437: "ibm437",
  850: "ibm850",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  54936: "gb18030",
  65001: "utf-8",
};

export function decodeOutput(buffer: Buffer, codePage: number): string {
  const label = CODE_PAGES[codePage] ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(label).decode(buffer);
  } catch {
    text = buffer.toString("utf8");
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
