/** Pure parsers for charter block JSON props — no BlockNote imports. */

export interface StakeholderRow {
  nameRole: string
  interest: string
  influence: string
  concern: string
}

export interface RiskRow {
  risk: string
  likelihood: string
  impact: string
  mitigation: string
}

export interface KpiItem {
  metric: string
  target: string
  method: string
}

export function parseStakeholderRows(raw: string): StakeholderRow[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((row) => ({
      nameRole: String(row?.nameRole ?? ''),
      interest: String(row?.interest ?? ''),
      influence: String(row?.influence ?? ''),
      concern: String(row?.concern ?? ''),
    }))
  } catch {
    return []
  }
}

export function parseRiskRows(raw: string): RiskRow[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((row) => ({
      risk: String(row?.risk ?? ''),
      likelihood: String(row?.likelihood ?? ''),
      impact: String(row?.impact ?? ''),
      mitigation: String(row?.mitigation ?? ''),
    }))
  } catch {
    return []
  }
}

export function parseKpiItems(raw: string): KpiItem[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => ({
      metric: String(item?.metric ?? ''),
      target: String(item?.target ?? ''),
      method: String(item?.method ?? ''),
    }))
  } catch {
    return []
  }
}
