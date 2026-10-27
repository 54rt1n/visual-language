import type { LearnerProfile } from '../domain/learning'
import type { SavedDraft } from '../domain/workspace'
import type { DictionaryCitation } from '../domain/dictionaryCitation'

export type ReadingCaptureDetails = { sourceText: string; start: number; end: number; pinyin?: string; dictionary?: DictionaryCitation }

export const CANVAS_UI = Symbol('visual-language-canvas-ui')
export type CanvasUI = {
  concealed(): boolean
  revealMaterial(): void
  pinyinDisplay(nodeId?: string): LearnerProfile['pinyinDisplay']
  hoverToExplore(): boolean
  openGraphTools(nodeId: string): void
  deleteNode(nodeId: string): void
  generateReply(nodeId: string): void
  readResponse(nodeId: string): void
  createLesson(nodeId: string): void
  ensureNodeVisible(nodeId: string): Promise<void>
  addLearningWord(nodeId: string, sourceText: string, start: number, end: number, pinyin: string): Promise<void>
  saveForPractice(nodeId: string, text: string, meaning: string, details: ReadingCaptureDetails): void
  isSavedForPractice(nodeId: string, text: string): boolean
  explainWord(nodeId: string): void
  stopExplanation(): void
  readingBusy(): boolean
  languageSetup(): void
  requestBusy(): boolean
  toggleCollapse(nodeId: string): void
  nodeFlags(nodeId: string): { bookmarked: boolean; collapsed: boolean } | undefined
  practiceItem(itemId: string): void
  captureItem(nodeId: string): void
  savedReading(nodeId: string, text: string, start: number, end: number): Promise<SavedDraft | undefined>
  readingRevision(): string
  savedReadings(nodeId: string, text: string): Promise<SavedDraft[]>
  dictionarySources(itemId: string): DictionaryCitation[]
  exerciseSummary(exerciseId: string): { mode: string; prompt: string; answer?: string; feedback?: string; cardId: string } | undefined
  practiceCard(cardId: string): void
  reviewHistory(cardId: string): void
  openDiscovery(draftId?: string): void
  lessonSummary(draftId: string): { title: string; kind: string; phraseCount: number; sourceCount: number; passage: string } | undefined
}
