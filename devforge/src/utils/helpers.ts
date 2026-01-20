export function mergeCss(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}