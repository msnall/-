export async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch { /* Fall back for browsers without clipboard permission. */ }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}
