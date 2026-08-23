import { z } from 'zod'

/**
 * Document contracts (plan §5 / §12). `DocumentSpec` is the high-level intent;
 * `DocumentGenerationState` tracks section-by-section progress without faking
 * token-level percentages.
 */
export type DocumentGenerationStatus =
  | 'queued'
  | 'outlining'
  | 'generating'
  | 'validating'
  | 'completed'
  | 'failed'

export interface DocumentGenerationState {
  documentId: string
  status: DocumentGenerationStatus
  completedSections: number
  totalSections: number
  activeSection?: string
  error?: string
}

export const documentGenerationStateSchema = z.object({
  documentId: z.string(),
  status: z.enum([
    'queued',
    'outlining',
    'generating',
    'validating',
    'completed',
    'failed',
  ]),
  completedSections: z.number().int().nonnegative(),
  totalSections: z.number().int().nonnegative(),
  activeSection: z.string().optional(),
  error: z.string().optional(),
})

export interface DocumentSpec {
  id: string
  title: string
  documentTypeId: string
  objective: string
  outline: string[]
  requiredFindingDomains: string[]
  generation: DocumentGenerationState
}

export const documentSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  documentTypeId: z.string(),
  objective: z.string(),
  outline: z.array(z.string()),
  requiredFindingDomains: z.array(z.string()),
  generation: documentGenerationStateSchema,
})
