import {
  BlockNoteSchema,
  defaultBlockSpecs,
  filterSuggestionItems,
} from '@blocknote/core'
import { createCallout } from './blocks/Callout'
import { createKpiGrid } from './blocks/KpiGrid'
import { createStakeholderTable } from './blocks/StakeholderTable'
import { createRiskList } from './blocks/RiskList'
import { createScopeBounds } from './blocks/ScopeBounds'
import { createDiagram } from './blocks/Diagram'
import { createAiChat } from './blocks/AiChat'

export const canvasSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: createCallout(),
    kpiGrid: createKpiGrid(),
    scopeBounds: createScopeBounds(),
    stakeholderTable: createStakeholderTable(),
    riskList: createRiskList(),
    diagram: createDiagram(),
    aiChat: createAiChat(),
  },
})

export { filterSuggestionItems }
export {
  CANVAS_INSERT_ITEMS,
  getCanvasSlashMenuItems,
  getAiSlashMenuItem,
  insertAiChatBlock,
  focusCanvasBlock,
  removeCanvasBlockById,
  type CanvasEditor,
  type CanvasInsertItem,
} from './canvasInsert'
