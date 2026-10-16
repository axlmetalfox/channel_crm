// ============================================================
// Messages that carry no information and are not worth an AI reply.
// ============================================================

/**
 * The pre-filled "¡Hola! mi nombre es ___ y busco información sobre ___"
 * sent with its blanks untouched. A version where the person filled in
 * either blank (a name, or what they are looking for) is a real message
 * and does not match.
 */
const BLANK_TEMPLATE =
  /^[^\p{L}\p{N}]*hola[^\p{L}\p{N}_]*mi\s+nombre\s+es\s*[_＿]{2,}\s*y\s+busco\s+informaci[oó]n\s+sobre\s*[_＿]{2,}[^\p{L}\p{N}]*$/iu

export function isBlankTemplate(text: string | null | undefined): boolean {
  return !!text && BLANK_TEMPLATE.test(text.replace(/\s+/g, ' ').trim())
}
