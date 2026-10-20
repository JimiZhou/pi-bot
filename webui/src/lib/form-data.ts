export function formText(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim()
}

export function formNumber(form: FormData, name: string): number {
  return Number(form.get(name))
}

export function formBoolean(form: FormData, name: string): boolean {
  return form.get(name) === "on"
}

export function lines(value: string): string[] {
  return value.split(/[\n,]+/u).map((item) => item.trim()).filter(Boolean)
}
