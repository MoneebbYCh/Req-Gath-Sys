import { COLORS_DEFAULT, createStyleSpec } from '@blocknote/core'

function resolveTextColor(value: string): string {
  if (!value || value === 'default') return ''
  return value in COLORS_DEFAULT ? COLORS_DEFAULT[value].text : value
}

function resolveBackgroundColor(value: string): string {
  if (!value || value === 'default') return ''
  return value in COLORS_DEFAULT ? COLORS_DEFAULT[value].background : value
}

/** Named + arbitrary CSS colors (hex/rgb) via inline style. */
export const textColorStyle = createStyleSpec(
  { type: 'textColor', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span')
      const color = resolveTextColor(value)
      if (color) span.style.color = color
      return { dom: span, contentDOM: span }
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span')
      const color = resolveTextColor(value)
      if (color) span.style.color = color
      return { dom: span, contentDOM: span }
    },
    parse: (element) => {
      if (element.tagName === 'SPAN' && element.style.color) return element.style.color
      return undefined
    },
  },
)

export const backgroundColorStyle = createStyleSpec(
  { type: 'backgroundColor', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span')
      const color = resolveBackgroundColor(value)
      if (color) span.style.backgroundColor = color
      return { dom: span, contentDOM: span }
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span')
      const color = resolveBackgroundColor(value)
      if (color) span.style.backgroundColor = color
      return { dom: span, contentDOM: span }
    },
    parse: (element) => {
      if (element.tagName === 'SPAN' && element.style.backgroundColor) {
        return element.style.backgroundColor
      }
      return undefined
    },
  },
)

/** Font size as CSS length, e.g. "16px". */
export const fontSizeStyle = createStyleSpec(
  { type: 'fontSize', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span')
      if (value) span.style.fontSize = value
      return { dom: span, contentDOM: span }
    },
    parse: (element) => {
      if (element.tagName === 'SPAN' && element.style.fontSize) return element.style.fontSize
      return undefined
    },
  },
)

/** Font family as CSS font-family list. */
export const fontFamilyStyle = createStyleSpec(
  { type: 'fontFamily', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span')
      if (value) span.style.fontFamily = value
      return { dom: span, contentDOM: span }
    },
    parse: (element) => {
      if (element.tagName === 'SPAN' && element.style.fontFamily) return element.style.fontFamily
      return undefined
    },
  },
)

export const TEXT_COLOR_KEYS = [
  'default',
  'gray',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
] as const

export const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'System Sans', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: 'Times New Roman, Times, serif' },
  { label: 'Courier New', value: 'Courier New, Courier, monospace' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS, sans-serif' },
  { label: 'Palatino', value: 'Palatino, Palatino Linotype, serif' },
  { label: 'Garamond', value: 'Garamond, serif' },
  { label: 'Monospace', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
]

export const FONT_SIZES = [
  '10px',
  '11px',
  '12px',
  '13px',
  '14px',
  '16px',
  '18px',
  '20px',
  '24px',
  '28px',
  '32px',
  '36px',
  '48px',
  '64px',
] as const

export function colorSwatch(key: string, kind: 'text' | 'background'): string {
  if (key === 'default') return kind === 'text' ? '#1a1a22' : 'transparent'
  const entry = COLORS_DEFAULT[key]
  if (!entry) return kind === 'text' ? key : key
  return kind === 'text' ? entry.text : entry.background
}
