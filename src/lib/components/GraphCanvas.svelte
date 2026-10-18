<script lang="ts">
  import { onMount, setContext, tick } from 'svelte'
  import { Maximize } from '@lucide/svelte'
  import {
    SvelteFlow,
    Background,
    Controls,
    ControlButton,
    MiniMap,
    Panel,
    useSvelteFlow,
    type Edge,
  } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'

  import RootNode from './nodes/RootNode.svelte'
  import UserNode from './nodes/UserNode.svelte'
  import AssistantNode from './nodes/AssistantNode.svelte'
  import GenericNode from './nodes/GenericNode.svelte'
  import ChunkNode from './nodes/ChunkNode.svelte'
  import ExplanationNode from './nodes/ExplanationNode.svelte'
  import ExerciseNode from './nodes/ExerciseNode.svelte'
  import LessonNode from './nodes/LessonNode.svelte'
  import SettingsDialog from './SettingsDialog.svelte'
  import SettingsHub from './SettingsHub.svelte'
  import ToolRail from './ToolRail.svelte'
  import TopicsDialog from './TopicsDialog.svelte'
  import TeacherPortrait from './TeacherPortrait.svelte'
  import DataDialog from './DataDialog.svelte'
  import { ImportedModelReviewRequired } from '../domain/original'
  import CaptureDialog from './CaptureDialog.svelte'
  import LibraryDialog from './LibraryDialog.svelte'
  import TeacherDialog from './TeacherDialog.svelte'
  import ReviewHistoryDialog from './ReviewHistoryDialog.svelte'
  import SearchDialog from './SearchDialog.svelte'
  import PwaDialog from './PwaDialog.svelte'
  import GraphToolsDialog from './GraphToolsDialog.svelte'
  import DemoDialog from './DemoDialog.svelte'
  import DiscoveryDialog from './DiscoveryDialog.svelte'
  import { modeFromHash, type WorkspaceMode } from '../domain/workspaceMode'
  import { PwaLifecycle } from '../pwa/lifecycle.svelte'
  import Modal from './Modal.svelte'
  import AboutDialog from './AboutDialog.svelte'
  import LanguageSetupDialog from './LanguageSetupDialog.svelte'
  import LessonDialog from './LessonDialog.svelte'
  import LessonsDialog from './LessonsDialog.svelte'
  import { lessonForSession } from '../domain/lesson'
  import { pendingLessonReview, pendingRecallExercise } from '../learning/lessonPolicy'
  import { LessonService } from '../learning/lessonService'
  import { conversationSelection } from '../learning/conversationPractice'
  import ResponseReader from './ResponseReader.svelte'
  import { nid } from '../id'
  import { conversationRequest } from '../ai/conversation'
  import { wordExplanationRequest } from '../ai/wordExplanation'
  import { unusableReplyReason } from '../ai/replyQuality'
  import { TeacherActivity } from '../teacher/activity'
  import {
    envApiKey,
    defaultSettings,
    loadSettings,
    providerNames,
    publicProviderPreferences,
    resolvedApiKey,
    type Settings,
  } from '../settings'
  import { WorkspaceState } from '../state/workspace.svelte'
  import { canvasGraph, updateGraphFromCanvas, type CanvasNode } from '../graph/canvas'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { Workspace } from '../domain/workspace'
  import { isDue } from '../learning/leitner'
  import { LearningService } from '../learning/learningService'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { ReadingService } from '../mandarin/readingService'
  import { containsHanzi } from '../mandarin/chineseParser'
  import { CANVAS_UI, type CanvasUI, type ReadingCaptureDetails } from '../graph/uiContext'
  import { readingSourceMatches } from '../mandarin/captureSource'
  import { GraphService, conversationAnchor, deletionScope, learningPreferences } from '../graph/graphService'

  const workspace = new WorkspaceState(modeFromHash(window.location.hash))
  const pwa = new PwaLifecycle()
  const nodeTypes = {
    root: RootNode,
    user: UserNode,
    assistant: AssistantNode,
    generic: GenericNode,
    chunk: ChunkNode,
    explanation: ExplanationNode,
    exercise: ExerciseNode,
    lesson: LessonNode,
  }

  const { updateNodeData, setViewport, getInternalNode } = useSvelteFlow()
  let canvasElement: HTMLDivElement | undefined = $state()
  let teacherElement: HTMLElement | undefined = $state(), teacherHeight = $state(0)
  let nodes = $state.raw<CanvasNode[]>([])
  let edges = $state.raw<Edge[]>([])
  let viewport = $state.raw({ x: 0, y: 0, zoom: 1 })
  // Follow a deliberately revealed/generated node, never a restored or manually
  // panned viewport. Its controls must stay in view when reading layout grows.
  let followNodeId = $state<string | undefined>()
  let ready = $state(false), graphDirty = $state(false), online = $state(true)
  let lastSavedGraph = ''
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let settingsLoadError = ''
  function initialSettings() {
    try { return loadSettings() } catch { settingsLoadError = 'Saved settings could not be read. They have not been overwritten. Open Settings to review.'; return defaultSettings() }
  }
  let settings = $state<Settings>(initialSettings())
  let draft = $state('')
  let status = $state(settingsLoadError)
  let streaming = $state(false)
  let conversationRequests = $state(0)
  const conversationActivity = new TeacherActivity(count => { conversationRequests = count })
  let modal = $state<'lessons' | 'conversation-practice' | 'settings' | 'providers' | 'more' | 'topics' | 'data' | 'capture' | 'library' | 'teacher' | 'history' | 'search' | 'source-help' | 'pwa' | 'graph' | 'delete-node' | 'demo' | 'discovery' | 'about' | null>(null)
  // Auxiliary setup can sit above an activity without unmounting its unsaved form.
  let languageSetupOpen = $state(false)
  let practiceItemId = $state<string | undefined>()
  let practiceAnchorId = $state(''), practiceSessionId = $state<string | undefined>()
  let practiceAutoStart = $state(false)
  const branchSelection = $derived(ready && workspace.snapshot && nodes.length ? conversationSelection(workspace.snapshot.state, selectedOrLast().id) : undefined)
  const savedPreparedLesson = $derived(workspace.snapshot?.state.sessions.filter(s => s.lessonAttempt && s.learnerId === workspace.snapshot!.state.activeLearnerId && s.status !== 'completed' && lessonForSession(workspace.snapshot!.state, s)?.archivedAt === undefined).at(-1))
  let discoveryDraftId = $state<string | undefined>()
  let graphNodeId = $state<string | undefined>()
  let deleteNodeId = $state<string | undefined>(), deleteNodeScope = $state<ReturnType<typeof deletionScope> | undefined>()
  let startingRequest = $state(false), graphBusy = $state(false)
  let navigationSaved = false
  let targetCardId = $state<string | undefined>(), captureNodeId = $state<string | undefined>(), captureText = $state(''), captureMeaning = $state(''), helpBusy = $state(false), helpError = $state('')
  let captureDetails = $state<ReadingCaptureDetails | undefined>()
  let readingFocusId = $state<string | undefined>()
  const readingFocusNode = $derived(workspace.snapshot?.state.nodes.find(node => node.id === readingFocusId))
  let librarySection = $state<'cards' | 'readings'>('cards'), readingDraftId = $state<string | undefined>()
  let pendingSourceAction: (() => void) | undefined
  let wallTime = $state(Date.now())
  let abort: AbortController | null = null

  const hasEnvKey = $derived(Boolean(envApiKey(settings.selected)))
  const profile = $derived(settings.profiles[settings.selected])
  const hasKey = $derived(Boolean(resolvedApiKey(settings)))
  const dueCount = $derived(workspace.snapshot?.state.cards.filter(c => isDue(c, workspace.snapshot?.state.demo?.enabled ? workspace.snapshot.state.demo.now : wallTime)).length ?? 0)
  const teacherCollapsed = $derived(workspace.snapshot?.state.view.teacherCollapsed ?? false)
  const teacherPortraits = $derived(workspace.snapshot?.state.view.teacherPortraits ?? true)
  const prerecorded = $derived(workspace.mode === 'demo' && workspace.snapshot?.state.demo?.contentMode === 'fixtures')
  const showConnectionEntry = $derived(ready && !hasKey && !prerecorded && !nodes.some(node => node.type === 'user' || node.type === 'assistant'))
  const savedLesson = $derived(workspace.snapshot?.state.sessions.find(s => !s.lessonAttempt && s.learnerId === workspace.snapshot!.state.activeLearnerId && s.status !== 'completed'))
  const protectedExercise = $derived(workspace.snapshot ? pendingRecallExercise(workspace.snapshot.state) : undefined)
  const protectedLessonReview = $derived(workspace.snapshot ? pendingLessonReview(workspace.snapshot.state) : undefined)
  const recallProtected = $derived(Boolean(protectedExercise || protectedLessonReview))
  // Reading-note writes do not replace the live canvas: unsent drafts and in-flight edits stay put.
  const reader = new ReadingService(teacherHost(workspace, () => {}), () => settings, conversationActivity.transport, () => workspaceClock(workspace).now())
  setContext<CanvasUI>(CANVAS_UI, {
    concealed: () => recallProtected, revealMaterial: () => requestSourceAction(() => { modal = null }),
    pinyinDisplay: nodeId => workspace.snapshot ? learningPreferences(workspace.snapshot.state, nodeId).pinyinDisplay : 'always',
    openGraphTools: nodeId => { void openGraphTools(nodeId) }, deleteNode: nodeId => { void requestDeleteNode(nodeId) }, toggleCollapse: nodeId => { void toggleCollapse(nodeId) },
    generateReply: nodeId => { void generateReply(nodeId) }, requestBusy: () => !ready || streaming || startingRequest || graphBusy || prerecorded || workspace.status === 'conflict',
    readResponse: nodeId => { void openResponseReader(nodeId) },
    addLearningWord,
    saveForPractice: (nodeId, text, meaning, details) => { readingFocusId = undefined; void openCapture(nodeId, { text, meaning, details }) },
    isSavedForPractice: (nodeId, text) => Boolean(workspace.snapshot?.state.items.some(i => i.canonicalText === text && i.sourceNodeIds.includes(nodeId))),
    explainWord: nodeId => { void explainWord(nodeId) },
    stopExplanation: stop,
    readingBusy: () => !ready || streaming || startingRequest || graphBusy,
    languageSetup: () => { languageSetupOpen = true },
    nodeFlags: nodeId => { const node = workspace.snapshot?.state.nodes.find(n => n.id === nodeId); return node ? { bookmarked: node.bookmarked, collapsed: node.collapsed } : undefined },
    practiceItem: itemId => { const source = workspace.snapshot?.state.items.find(i => i.id === itemId)?.sourceNodeIds.find(id => workspace.snapshot?.state.nodes.some(n => n.id === id)); if (source) { void openConversationPractice(undefined, source, itemId); return } const cards = workspace.snapshot?.state.cards.filter(c => c.itemId === itemId && c.status !== 'suspended') ?? []; const card = cards.find(c => c.skill === 'production') ?? cards[0]; if (card) void openTeacher(card.id) },
    captureItem: nodeId => { void openCapture(nodeId) },
    savedReading: (nodeId, text, start, end) => reader.saved(nodeId, text, start, end),
    readingRevision: () => `${workspace.snapshot?.version.generation}:${workspace.snapshot?.version.revision}`,
    savedReadings: (nodeId, text) => reader.notes(nodeId, text),
    dictionarySources: itemId => workspace.snapshot?.state.items.find(item => item.id === itemId)?.dictionarySources ?? [],
    practiceCard: cardId => { void openTeacher(cardId) },
    reviewHistory: cardId => { void openHistory(cardId) },
    openDiscovery: draftId => { void openDiscovery(draftId) },
    lessonSummary: draftId => {
      const draft = workspace.snapshot?.state.drafts.find(d => d.id === draftId && d.kind === 'discovery' && d.status === 'validated'), lesson = draft?.discovery
      return lesson ? { title: lesson.title, kind: draft!.discoveryRequest!.kind, phraseCount: lesson.phrases.length, sourceCount: draft!.sourceIds.length, passage: lesson.passageHanzi.slice(0, 180) } : undefined
    },
    exerciseSummary: exerciseId => {
      const saved = workspace.snapshot?.state, exercise = saved?.exercises.find(e => e.id === exerciseId)
      if (!saved || !exercise) return undefined
      const attempt = saved.attempts.filter(a => a.exerciseId === exerciseId).at(-1)
      return { mode: exercise.mode, prompt: exercise.prompt, answer: attempt?.answer, feedback: attempt?.assessment?.feedback, cardId: exercise.cardId }
    },
  })

  function captureGraph() {
    if (!workspace.snapshot) throw new Error('Local data is still loading.')
    const state = structuredClone(workspace.snapshot.state)
    updateGraphFromCanvas(state, nodes, edges, draft, viewport)
    return { nodes: state.nodes, edges: state.edges, view: state.view }
  }
  async function flushDraft() {
    if (saveTimer) clearTimeout(saveTimer)
    if (!ready) throw new Error('The local workspace is not open.')
    const captured = captureGraph(), signature = JSON.stringify(captured)
    if (signature === lastSavedGraph) { graphDirty = false; return }
    await workspace.mutate('save-graph', captured, state => {
      state.nodes = captured.nodes; state.edges = captured.edges
      state.view = { ...state.view, ...captured.view }
    })
    lastSavedGraph = signature
    graphDirty = JSON.stringify(captureGraph()) !== signature
  }
  function applySaved(snapshot: WorkspaceSnapshot) {
    if (readingFocusId && snapshot.state.nodes.find(node => node.id === readingFocusId)?.rootId !== snapshot.state.view.activeRootId) readingFocusId = undefined
    const graph = canvasGraph(snapshot.state)
    nodes = graph.nodes; edges = graph.edges; draft = snapshot.state.view.composerDraft; viewport = { ...snapshot.state.view.viewport }
    lastSavedGraph = JSON.stringify({ nodes: snapshot.state.nodes, edges: snapshot.state.edges, view: snapshot.state.view })
    graphDirty = false
    void tick().then(() => setViewport(snapshot.state.view.viewport))
  }
  onMount(() => {
    let disposed = false
    const stopPwa = pwa.start()
    online = navigator.onLine
    const connected = () => { online = navigator.onLine }
    window.addEventListener('online', connected); window.addEventListener('offline', connected)
    const refreshCalendar = () => { if (document.visibilityState === 'visible') workspace.refreshLearningCalendar() }
    window.addEventListener('focus', refreshCalendar); document.addEventListener('visibilitychange', refreshCalendar)
    const timeTicker = setInterval(() => { wallTime = Date.now() }, 15_000)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!navigationSaved && (graphDirty || streaming || graphBusy || startingRequest)) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    void workspace.open(() => { abort?.abort(); if (saveTimer) clearTimeout(saveTimer) }).then(() => {
      if (disposed) { workspace.close(); return }
      applySaved(workspace.snapshot!); ready = true
    }).catch(() => {})
    return () => {
      disposed = true; stopPwa(); abort?.abort(); clearInterval(timeTicker); if (saveTimer) clearTimeout(saveTimer)
      workspace.close(); window.removeEventListener('online', connected); window.removeEventListener('offline', connected); window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('focus', refreshCalendar); document.removeEventListener('visibilitychange', refreshCalendar)
    }
  })

  $effect(() => {
    // Capture reactive dependencies now; the delayed save does not auto-retry failures.
    nodes; edges; draft; viewport
    if (!ready || modal || workspace.status === 'conflict' || workspace.status === 'error') return
    graphDirty = true
    saveTimer = setTimeout(() => { void flushDraft().catch(() => {}) }, 350)
    return () => { if (saveTimer) clearTimeout(saveTimer) }
  })

  $effect(() => {
    const dock = teacherElement
    if (!dock) return
    const observer = new ResizeObserver(() => { teacherHeight = dock.getBoundingClientRect().height })
    observer.observe(dock)
    return () => observer.disconnect()
  })

  $effect(() => {
    const id = followNodeId
    if (!id || modal || languageSetupOpen || graphBusy || startingRequest || streaming) return
    let disposed = false, frame = 0, observer: ResizeObserver | undefined
    void tick().then(() => {
      if (disposed || !canvasElement) return
      const element = canvasElement.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${CSS.escape(id)}"]`)
      if (!element) return
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => { if (!disposed) void focusNode(id, false, false) })
      })
      observer.observe(element); observer.observe(canvasElement)
      if (teacherElement) observer.observe(teacherElement)
    })
    return () => { disposed = true; observer?.disconnect(); cancelAnimationFrame(frame) }
  })

  function selectedOrLast(): CanvasNode {
    const conversation = nodes.filter(n => !n.hidden && ['root', 'user', 'assistant'].includes(n.type ?? ''))
    const selected = nodes.find(n => n.selected && !n.hidden), saved = workspace.snapshot?.state
    const anchor = saved && selected ? conversationAnchor(saved, selected.id) : undefined
    return conversation.find(n => n.id === anchor?.id) ?? conversation.filter(n => !n.hidden && saved?.nodes.some(s => s.id === n.id && s.rootId === saved.view.activeRootId)).at(-1) ?? conversation.at(-1)!
  }

  function nodeSize(nodeId: string) {
    const measured = getInternalNode(nodeId)?.measured
    const element = canvasElement?.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${CSS.escape(nodeId)}"]`)
    return { width: element?.offsetWidth || measured?.width || 360, height: element?.offsetHeight || measured?.height || 300 }
  }
  async function settleLayout() {
    await tick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  function nextConversationPosition(parentId: string, pendingId?: string) {
    const parent = nodes.find(node => node.id === parentId)!
    const occupied = nodes.filter(node => node.id !== pendingId && !node.hidden)
    const branching = edges.some(edge => edge.source === parentId && edge.target !== pendingId && edge.data?.kind === 'conversation')
    // A fresh branch gets a free column; continuing a branch stays below all
    // existing material in its column. Never rearrange the learner's old nodes.
    const x = branching ? Math.max(...occupied.map(node => node.position.x + nodeSize(node.id).width)) + 48 : parent.position.x
    const bottoms = occupied.filter(node => node.position.x < x + 360 && node.position.x + nodeSize(node.id).width > x)
      .map(node => node.position.y + nodeSize(node.id).height)
    return { x, y: Math.max(parent.position.y + nodeSize(parentId).height, ...bottoms) + 64 }
  }
  function nextLearningPosition(parentId: string) {
    const parent = nodes.find(node => node.id === parentId)!
    return { x: Math.max(...nodes.filter(node => !node.hidden).map(node => node.position.x + nodeSize(node.id).width)) + 64, y: parent.position.y }
  }
  async function addLearningWord(nodeId: string, sourceText: string, start: number, end: number, pinyin: string) {
    if (!ready || streaming || startingRequest || graphBusy || workspace.status === 'conflict') throw new Error('Wait for the current request or save to finish.')
    graphBusy = true
    try {
      await flushDraft(); await settleLayout()
      const next = await workspace.apply((snapshot, repository) => new GraphService(repository, workspaceClock(workspace)).addLearningWord(snapshot, nodeId, sourceText, start, end, pinyin, nextLearningPosition(nodeId)))
      applySaved(next)
      await focusNode(next.state.view.selectedNodeIds[0]!)
    } finally { graphBusy = false }
  }
  async function explainWord(nodeId: string) {
    if (!ready || streaming || startingRequest || graphBusy || workspace.status === 'conflict') return
    if (prerecorded) { status = 'Switch to live providers to explain this word.'; return }
    if (recallProtected) { requestSourceAction(() => { void explainWord(nodeId) }); return }
    startingRequest = true
    try {
      await flushDraft(); await settleLayout()
      const request = wordExplanationRequest(workspace.snapshot!.state, settings, nodeId)
      const next = await workspace.apply((snapshot, repository) => new GraphService(repository, workspaceClock(workspace)).addWordExplanation(snapshot, nodeId, nextLearningPosition(nodeId), request.provider, request.model))
      applySaved(next)
      const explanationId = next.state.view.selectedNodeIds[0]!
      // The new node is not in Svelte Flow's lookup until its next render.
      nodes = nodes.map(node => node.id === explanationId ? { ...node, data: { ...node.data, streaming: true } } : node)
      startingRequest = false
      await streamAssistant(explanationId, request)
    } catch (cause) {
      status = cause instanceof Error ? cause.message : 'The explanation could not start.'
      if (cause instanceof ImportedModelReviewRequired) { graphNodeId = nodeId; modal = 'graph' }
      else if (!resolvedApiKey(settings)) modal = 'providers'
    } finally { startingRequest = false }
  }

  async function openResponseReader(nodeId: string) {
    if (!ready || streaming || startingRequest || graphBusy) return
    try {
      await flushDraft()
      requestSourceAction(() => { readingFocusId = nodeId })
    } catch (cause) { status = cause instanceof Error ? cause.message : 'Could not open this response.' }
  }
  $effect(() => { if (modal || languageSetupOpen || recallProtected || !readingFocusNode) readingFocusId = undefined })

  async function send() {
    const text = draft.trim()
    if (!text || streaming || startingRequest || graphBusy || !ready || workspace.status === 'conflict') return
    if (prerecorded) { status = 'Prerecorded rehearsal has no generated conversation. Use the teacher or switch to live providers in Demo & rehearsal.'; return }
    if (recallProtected) { requestSourceAction(() => { modal = null; void send() }); return }
    startingRequest = true
    try {
    await flushDraft()
    let parent = selectedOrLast()
    let request: ReturnType<typeof conversationRequest>
    try { request = conversationRequest(workspace.snapshot!.state, settings, parent.id) }
    catch (cause) { status = cause instanceof Error ? cause.message : 'Review the branch provider settings.'; if (cause instanceof ImportedModelReviewRequired) { graphNodeId = parent.id; modal = 'graph' } else modal = 'providers'; return }
    if (workspace.snapshot!.state.nodes.find(n => n.id === parent.id)?.collapsed) {
      applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).reveal(s, parent.id)))
      parent = nodes.find(n => n.id === parent.id)!
    }
    await settleLayout()
    const position = nextConversationPosition(parent.id)

    const userId = nid('u')
    const assistantId = nid('a')

    const userNode: CanvasNode = {
      id: userId,
      type: 'user',
      position,
      data: { text },
    }
    const assistantNode: CanvasNode = {
      id: assistantId,
      type: 'assistant',
      position: { x: position.x, y: position.y + 180 },
      data: { text: '', reasoning: '', streaming: true, error: '', state: 'interrupted', provider: request.provider, model: request.model },
    }

    nodes = [
      ...nodes.map((n) => ({ ...n, selected: false })),
      userNode,
      { ...assistantNode, selected: true },
    ]
    edges = [
      ...edges,
      { id: nid('e'), source: parent.id, target: userId, data: { kind: 'conversation' } },
      { id: nid('e'), source: userId, target: assistantId, data: { kind: 'conversation' } },
    ]
    draft = ''
    // Long learner messages must be mounted before placing their response.
    await settleLayout()
    nodes = nodes.map(node => node.id === assistantId ? { ...node, position: nextConversationPosition(userId, assistantId) } : node)
    startingRequest = false
    await streamAssistant(assistantId, { ...request, messages: [...request.messages, { role: 'user', content: text }] })
    } catch (cause) { status = cause instanceof Error ? cause.message : 'Could not save the conversation.' }
    finally { startingRequest = false }
  }

  async function generateReply(originalId: string) {
    if (!ready || streaming || startingRequest || graphBusy || workspace.status === 'conflict') return
    if (prerecorded) { status = 'Switch to live demo mode to generate a reply.'; return }
    if (recallProtected) { requestSourceAction(() => { void generateReply(originalId) }); return }
    startingRequest = true
    modal = null
    try {
      await flushDraft()
      const original = workspace.snapshot!.state.nodes.find(n => n.id === originalId && ['user', 'assistant'].includes(n.type))
      const retry = original?.type === 'assistant'
      const parentId = retry ? workspace.snapshot!.state.edges.find(e => e.target === originalId && e.data.kind === 'conversation')?.source : original?.id
      if (!original || !parentId) throw new Error('Choose a saved message to reply to.')
      const request = conversationRequest(workspace.snapshot!.state, settings, originalId, parentId)
      applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).reveal(s, originalId)))
      await settleLayout()
      const assistantId = nid('a')
      nodes = [...nodes.map(n => ({ ...n, selected: false })), { id: assistantId, type: 'assistant', selected: true,
        position: nextConversationPosition(parentId),
        data: { text: '', reasoning: '', streaming: true, error: '', state: 'interrupted', provider: request.provider, model: request.model, ...(retry ? { regeneratedFrom: originalId } : {}) } }]
      edges = [...edges, { id: nid('edge'), source: parentId, target: assistantId, data: { kind: 'conversation' } },
        ...(retry ? edges.filter(e => e.target === originalId && e.data?.kind === 'context').map(e => ({ ...e, id: nid('edge'), target: assistantId })) : [])]
      modal = null
      if (request.messages.length === 1) request.messages.push({ role: 'user', content: 'Provide a fresh response for this Mandarin conversation.' })
      startingRequest = false
      await streamAssistant(assistantId, request)
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The reply could not start.'; if (cause instanceof ImportedModelReviewRequired) { graphNodeId = originalId; modal = 'graph' } else if (!resolvedApiKey(settings)) modal = 'providers' }
    finally { startingRequest = false }
  }

  async function streamAssistant(assistantId: string, request: ReturnType<typeof conversationRequest>) {
    streaming = true
    status = `Waiting for ${providerNames[request.provider]} · ${request.model}…`

    abort = new AbortController()
    let content = ''
    let reasoning = ''
    let raf = 0
    let reportedModel = request.model, checkedAt = 0

    const flush = () => {
      raf = 0
      updateNodeData(assistantId, { text: content, reasoning, streaming: true, error: '' })
    }

    try {
      await flushDraft() // The prompt and interrupted reply are durable before paid work starts.
      await focusNode(assistantId, false)
      const result = await conversationActivity.transport({
        ...request,
        handlers: {
          signal: abort.signal,
          onModel: model => { reportedModel = model },
          onHeartbeat: () => {
            status = `${providerNames[request.provider]} is still working…`
          },
          onContent: (chunk) => {
            content += chunk
            if (content.length - checkedAt >= 64) {
              checkedAt = content.length
              const problem = unusableReplyReason(content)
              if (problem) throw new Error(problem)
            }
            status = 'streaming'
            if (!raf) raf = requestAnimationFrame(flush)
          },
          onReasoning: (chunk) => {
            reasoning += chunk
            if (!raf) raf = requestAnimationFrame(flush)
          },
        },
      })
      if (raf) cancelAnimationFrame(raf)
      const problem = unusableReplyReason(content, true)
      updateNodeData(assistantId, {
        text: content,
        reasoning,
        streaming: false,
        error: problem ?? '',
        state: problem ? 'error' : 'complete', model: result.model,
      })
      status = problem ?? ''
    } catch (err) {
      if (raf) cancelAnimationFrame(raf)
      const message = err instanceof Error ? err.message : String(err)
      const aborted = err instanceof DOMException && err.name === 'AbortError'
      updateNodeData(assistantId, {
        text: content,
        reasoning,
        streaming: false,
        error: aborted ? '' : message,
        state: aborted ? 'interrupted' : 'error',
        model: reportedModel,
      })
      status = aborted ? 'stopped' : message
    } finally {
      streaming = false
      abort = null
      await tick()
      await flushDraft().catch(() => {})
      await focusNode(assistantId, false)
    }
  }

  function stop() {
    abort?.abort()
  }

  async function newTopic() {
    if (!ready || streaming || startingRequest || graphBusy || workspace.status === 'conflict') return
    graphBusy = true
    followNodeId = undefined
    try {
      await flushDraft(); applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).createTopic(s)))
      status = 'New topic created.'
      await fitGraph(); await flushDraft()
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The topic could not be saved.' }
    finally { graphBusy = false }
  }
  async function openGraphTools(nodeId?: string) {
    if (!ready || streaming || graphBusy || startingRequest) return
    try { await flushDraft(); requestSourceAction(() => { graphNodeId = nodeId ?? nodes.find(n => n.selected)?.id; modal = 'graph' }) }
    catch (cause) { status = cause instanceof Error ? cause.message : 'Could not save before opening graph tools.' }
  }
  async function requestDeleteNode(nodeId: string) {
    if (!ready || streaming || graphBusy || startingRequest || workspace.status === 'conflict') return
    try {
      await flushDraft()
      const saved = workspace.snapshot?.state
      if (!saved?.nodes.some(node => node.id === nodeId)) throw new Error('This node is no longer available.')
      deleteNodeId = nodeId; deleteNodeScope = deletionScope(saved, nodeId); modal = 'delete-node'
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The delete confirmation could not open.' }
  }
  async function confirmDeleteNode() {
    if (!deleteNodeId || !deleteNodeScope || graphBusy) return
    graphBusy = true
    try {
      await flushDraft()
      const preview = deleteNodeScope
      applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).deleteSubtree(s, deleteNodeId!, preview.nodeIds)))
      status = `Removed ${preview.nodeIds.length} graph ${preview.nodeIds.length === 1 ? 'node' : 'nodes'}. Learning history was kept.`
      modal = null; deleteNodeId = undefined; deleteNodeScope = undefined
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The node could not be deleted.' }
    finally { graphBusy = false }
  }
  async function toggleCollapse(nodeId: string) {
    if (!ready || streaming || graphBusy || startingRequest) return
    graphBusy = true
    try {
      await flushDraft()
      const node = workspace.snapshot!.state.nodes.find(n => n.id === nodeId)
      if (node) applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).setFlag(s, nodeId, 'collapsed', !node.collapsed)))
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The branch display was not changed.' }
    finally { graphBusy = false }
  }
  async function openData() {
    if (streaming) return
    try { await flushDraft(); modal = 'data' } catch { modal = 'data' }
  }
  async function openConversationPractice(resumeId?: string, sourceId?: string, itemId?: string, startImmediately = false) {
    if (!ready || streaming || graphBusy) return
    try {
      await flushDraft()
      requestSourceAction(() => {
        practiceAnchorId = sourceId ?? lessonForSession(workspace.snapshot!.state, workspace.snapshot!.state.sessions.find(s => s.id === resumeId))?.anchorId ?? selectedOrLast().id
        practiceItemId = itemId
        practiceSessionId = resumeId
        practiceAutoStart = startImmediately
        readingFocusId = undefined
        modal = 'conversation-practice'
      })
    } catch (cause) { status = cause instanceof Error ? cause.message : 'Could not open conversation practice.' }
  }
  async function openTeacher(cardId?: string) {
    if (!ready || streaming) return
    try { await flushDraft(); targetCardId = cardId; modal = 'teacher' } catch (error) { status = error instanceof Error ? error.message : 'Could not save before opening the teacher.' }
  }
  function requestSourceAction(action: () => void) {
    if (recallProtected) { pendingSourceAction = action; helpError = ''; modal = 'source-help' }
    else action()
  }
  async function openCapture(sourceId?: string, reading?: { text: string; meaning: string; details?: ReadingCaptureDetails }) {
    if (!ready || streaming) return
    await flushDraft().catch(() => {})
    requestSourceAction(() => {
      const selected = workspace.snapshot?.state.nodes.find(n => n.id === sourceId) ?? workspace.snapshot?.state.nodes.find(n => nodes.some(canvas => canvas.id === n.id && canvas.selected))
      if (reading?.details && !readingSourceMatches(selected, reading.text, { nodeId: sourceId ?? '', ...reading.details })) {
        status = 'The response changed. Select the word again before saving it.'; return
      }
      captureNodeId = selected?.id
      const selection = reading?.text ?? window.getSelection()?.toString().trim() ?? ''
      captureText = containsHanzi(selection) && selected && 'text' in selected.data && selected.data.text.includes(selection) ? selection : ''
      captureMeaning = captureText && reading ? reading.meaning : ''
      captureDetails = captureText ? reading?.details : undefined
      modal = 'capture'
    })
  }
  async function openLibrary(section: 'cards' | 'readings' = 'cards', draftId?: string) { await flushDraft().catch(() => {}); requestSourceAction(() => { librarySection = section; readingDraftId = draftId; modal = 'library' }) }
  async function openHistory(cardId?: string) { await flushDraft().catch(() => {}); requestSourceAction(() => { targetCardId = cardId; modal = 'history' }) }
  async function openSearch() { await flushDraft().catch(() => {}); requestSourceAction(() => { modal = 'search' }) }
  async function openDiscovery(draftId?: string) {
    if (!ready || streaming || graphBusy || startingRequest) return
    try { await flushDraft(); requestSourceAction(() => { discoveryDraftId = draftId; modal = 'discovery' }) }
    catch (cause) { status = cause instanceof Error ? cause.message : 'Could not save before opening discovery lessons.' }
  }
  function visibleCanvas() {
    const bounds = canvasElement!.getBoundingClientRect()
    const rail = canvasElement!.querySelector('.tool-rail')?.getBoundingClientRect()
    // Status is a background layer, not an obstacle to reading or panning.
    // The flow fills the screen behind Zheng; frame new/revealed replies above
    // his floating dock, without restricting manual panning into that area.
    const left = Math.max(16, (rail?.right ?? bounds.left) - bounds.left + 16)
    const top = 16
    const bottom = Math.min(bounds.height - 48, (teacherElement?.getBoundingClientRect().top ?? bounds.bottom) - bounds.top - 16)
    return { left, top, width: Math.max(100, bounds.width - 20 - left), height: Math.max(24, bottom - top) }
  }
  async function frameBounds(bounds: { x: number; y: number; width: number; height: number }, animate: boolean) {
    const area = visibleCanvas()
    const zoom = Math.max(0.05, Math.min(1, area.width / (bounds.width + 20), area.height / (bounds.height + 20)))
    await setViewport({ x: area.left + area.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: area.top + area.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom }, { duration: animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 250 : 0 })
  }
  async function fitGraph() {
    followNodeId = undefined
    await settleLayout()
    const visible = nodes.filter(node => !node.hidden)
    if (!visible.length || !canvasElement) return
    const x = Math.min(...visible.map(node => node.position.x)), y = Math.min(...visible.map(node => node.position.y))
    const right = Math.max(...visible.map(node => node.position.x + nodeSize(node.id).width))
    const bottom = Math.max(...visible.map(node => node.position.y + nodeSize(node.id).height))
    await frameBounds({ x, y, width: right - x, height: bottom - y }, true)
  }
  async function focusNode(nodeId: string, animate = true, follow = true) {
    if (follow) followNodeId = nodeId
    await settleLayout()
    if (followNodeId !== nodeId) return
    const target = nodes.find(n => n.id === nodeId)
    if (!target || !canvasElement) return
    await frameBounds({ ...target.position, ...nodeSize(nodeId) }, animate)
  }
  async function revealNode(nodeId: string) {
    if (graphBusy || streaming || startingRequest) return
    requestSourceAction(() => {
      const sourceModal = modal
      void (async () => {
        graphBusy = true
        try {
          await flushDraft()
          if (!workspace.snapshot!.state.nodes.some(n => n.id === nodeId)) { status = 'The original graph node was removed. Saved excerpts and learning history are retained.'; return }
          applySaved(await workspace.apply((s, r) => new GraphService(r, workspaceClock(workspace)).reveal(s, nodeId)))
          if (modal === sourceModal) modal = null
          await focusNode(nodeId)
        } catch (cause) { status = cause instanceof Error ? cause.message : 'The source could not be revealed.' }
        finally { graphBusy = false }
      })()
    })
  }
  async function confirmSourceHelp() {
    if (!recallProtected) { pendingSourceAction?.(); pendingSourceAction = undefined; return }
    helpBusy = true; helpError = ''
    try {
      const clock = workspaceClock(workspace), exerciseId = protectedExercise?.id
      const cardIds = protectedLessonReview ? lessonForSession(workspace.snapshot!.state, protectedLessonReview)!.cardIds : []
      const pending = workspace.snapshot!.state.attempts.find(a => a.exerciseId === exerciseId && a.status === 'pending')
      if (pending) await workspace.apply((snapshot, repository) => new LearningService(repository, clock).markGradingUnavailable(snapshot, pending.id, 'The interrupted grading request is not running. Source material was explicitly requested.'))
      const result = await workspace.apply((snapshot, repository) => exerciseId ? new LearningService(repository, clock).requestHelp(snapshot, exerciseId, 'source') : new LessonService(repository, clock).revealMaterial(snapshot, cardIds))
      applySaved(result)
      const action = pendingSourceAction; pendingSourceAction = undefined; modal = null; action?.()
    } catch (cause) { helpError = cause instanceof Error ? cause.message : 'Help could not be recorded. Source material remains hidden.' }
    finally { helpBusy = false }
  }
  function returnToQuestion() {
    pendingSourceAction = undefined
    if (protectedLessonReview) {
      practiceSessionId = protectedLessonReview.id; practiceAnchorId = lessonForSession(workspace.snapshot!.state, protectedLessonReview)!.anchorId
      practiceItemId = undefined; practiceAutoStart = false; modal = 'conversation-practice'
    } else void openTeacher()
  }
  async function reloadSaved() {
    if ((graphDirty || streaming) && !window.confirm('Reload the last saved workspace? Unsaved text currently visible in this tab will be discarded. Cancel to copy or download your draft first.')) return
    abort?.abort()
    try { applySaved(await workspace.reload()) } catch (error) { status = error instanceof Error ? error.message : 'Reload failed.' }
  }
  function downloadDraftRecovery() {
    const data = { format: 'visual-language-draft-recovery', warning: 'Uncommitted canvas draft only, not a full workspace backup.', capturedAt: new Date().toISOString(), ...captureGraph() }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'visual-language-draft-recovery.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
  async function toggleTeacher() {
    await flushDraft()
    await workspace.mutate('teacher-display', !teacherCollapsed, state => { state.view.teacherCollapsed = !state.view.teacherCollapsed })
  }
  async function togglePortraits() {
    try {
      await flushDraft()
      await workspace.mutate('teacher-portrait-display', { visible: !teacherPortraits }, state => { state.view.teacherPortraits = !(state.view.teacherPortraits ?? true) })
    } catch (cause) { status = cause instanceof Error ? cause.message : 'The portrait preference could not be saved.' }
  }
  async function prepareUpdate() {
    if (streaming) throw new Error('Stop the current response and save its partial text before updating.')
    await flushDraft()
    if (savedLesson) {
      const result = await workspace.apply((snapshot, repository) => new LearningService(repository, workspaceClock(workspace)).setSessionStatus(snapshot, savedLesson!.id, 'paused'))
      applySaved(result)
    }
    await workspace.flush()
  }
  async function openDemo() {
    if (!ready || streaming || graphBusy || startingRequest) return
    try { await prepareUpdate(); modal = 'demo' } catch (cause) { status = cause instanceof Error ? cause.message : 'Could not save before opening demo controls.' }
  }
  async function switchWorkspace(mode: WorkspaceMode) {
    await prepareUpdate()
    await tick(); await flushDraft(); await workspace.flush()
    // Explicit user navigation after durable save, not a service-worker reload.
    // A full reload also clears in-memory source caches and pending tool state.
    const target = new URL(window.location.href); target.hash = mode === 'demo' ? 'demo' : ''
    navigationSaved = true
    window.history.replaceState(null, '', target)
    window.location.reload()
  }

  async function openTopics() {
    if (!ready || streaming || graphBusy || startingRequest) return
    try { await flushDraft(); requestSourceAction(() => { modal = 'topics' }) }
    catch (cause) { status = cause instanceof Error ? cause.message : 'Could not open topics.' }
  }
  function selectTool(action: string) {
    workspace.refreshLearningCalendar()
    if (action === 'lessons') { void flushDraft().then(() => { modal = 'lessons' }).catch(cause => { status = String(cause) }) }
    else if (action === 'teacher') void openTeacher()
    else if (action === 'discovery') void openDiscovery()
    else if (action === 'capture') void openCapture()
    else if (action === 'library') void openLibrary()
    else if (action === 'search') void openSearch()
    else if (action === 'topics') void openTopics()
    else if (action === 'new-topic') void newTopic()
    else if (action === 'settings') modal = 'settings'
    else if (action === 'more') modal = 'more'
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void send()
    }
  }
</script>

<div class="workspace-layout" style={`--teacher-height: ${teacherHeight}px`}>
<div class="canvas" bind:this={canvasElement}>
  <!-- The interactivity control can re-enable handles; graph commands still own connections. -->
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    colorMode="dark"
    minZoom={0.05}
    maxZoom={8}
    onmovestart={event => { if (event) followNodeId = undefined }}
    onmoveend={(_event, value) => { viewport = value }}
    onnodeclick={({ node }) => { if (followNodeId !== node.id) followNodeId = undefined }}
    onnodedragstart={() => { followNodeId = undefined }}
    deleteKey={null}
    nodesConnectable={false}
    isValidConnection={() => false}
    nodesDraggable={!graphBusy && !startingRequest}
    elementsSelectable={!graphBusy && !startingRequest}
  >
    <Background gap={18} size={1} />
    <Controls orientation="horizontal" showFitView={false} onclick={() => { followNodeId = undefined }}>
      <ControlButton title="Fit View" aria-label="Fit View" onclick={() => { void fitGraph() }}><Maximize size={16} /></ControlButton>
    </Controls>
    <MiniMap pannable zoomable />

    <Panel position="top-right" class="background-status">
      <div class="vl-panel brand">
        <h2>Visual Language</h2>
        {#if workspace.mode === 'demo'}<p class="demo-badge" role="status">DEMO · {prerecorded ? 'prerecorded fixtures' : 'live provider path'}<br />{workspace.snapshot?.state.demo ? new Date(workspace.snapshot.state.demo.now).toISOString() : 'Opening isolated dataset…'}</p>{/if}
        <button type="button" class="connection-summary" aria-label="AI connection settings" disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => { modal = 'providers' }}>{providerNames[settings.selected]} · {profile.model}</button>
        <p class="vl-status">
          {#if streaming}
            {status}
          {:else if hasKey}
            {status || (hasEnvKey && !profile.apiKey ? 'local test key' : 'ready')}
          {:else}
            {status || 'Connect to start chatting'}
          {/if}
        </p>
        <p class="vl-status" role="status">{!ready ? 'Opening local workspace…' : graphDirty ? 'Unsaved changes…' : workspace.status === 'saved' ? 'Saved on this device' : workspace.status === 'saving' ? 'Saving…' : 'Save needs attention'} · {online ? 'Online' : 'No connection'}</p>
      </div>
      {#if pwa.updateAvailable || workspace.error}<div class="vl-panel status-actions">
        {#if pwa.updateAvailable}<button type="button" class="ghost" disabled={streaming || graphBusy || startingRequest} onclick={() => { modal = 'pwa' }}>App update ready</button>{/if}
        {#if workspace.error}<p class="save-error" role="alert">{workspace.error}</p><button type="button" class="ghost" onclick={reloadSaved}>Reload saved state</button>{#if ready}<button type="button" class="ghost" onclick={downloadDraftRecovery}>Download unsaved draft</button>{/if}{/if}
      </div>{/if}
    </Panel>

  </SvelteFlow>
  <ToolRail conflicted={workspace.status === 'conflict'} disabled={!ready || streaming || graphBusy || startingRequest} settingsDisabled={streaming || graphBusy || startingRequest} onSelect={selectTool} />
</div>
    <section class="teacher-panel" class:needs-connection={showConnectionEntry} aria-label="Zheng conversation dock" bind:this={teacherElement}>
      <div class="teacher-shortcuts">
      <button type="button" class="ghost demo-entry" disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => { void openDemo() }}>{workspace.mode === 'demo' ? 'Demo controls' : 'Try demo'}</button>
      <button class="teacher-toggle ghost" type="button" onclick={() => { void toggleTeacher().catch(() => {}) }} disabled={!ready || streaming || graphBusy || startingRequest} aria-expanded={!teacherCollapsed}>Zheng · {dueCount} due {teacherCollapsed ? '▴' : '▾'}</button>
      </div>
      {#if showConnectionEntry}<div class="connection-entry"><button type="button" disabled={streaming || graphBusy || startingRequest} onclick={() => { modal = 'providers' }}>Connect {providerNames[settings.selected]}</button><button type="button" class="ghost" disabled={streaming || graphBusy || startingRequest} onclick={() => { modal = 'providers' }}>Choose another provider</button></div>{/if}
      {#if !teacherCollapsed}
      <form
        class="vl-panel composer teacher-dialogue"
        class:has-portrait={ready && teacherPortraits && !modal && !languageSetupOpen}
        onsubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {#if ready && teacherPortraits && !modal && !languageSetupOpen}<TeacherPortrait state={conversationRequests ? 'thinking' : 'attentive'} variant="strip" />{/if}
        <div class="teacher-content">
        <h3>Zheng <span>Explore a conversation</span></h3>
        <div class="teacher-actions"><button type="button" class="ghost" disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => void openConversationPractice()}>Practice this conversation</button>{#if savedPreparedLesson}<button type="button" class="ghost" disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => void openConversationPractice(savedPreparedLesson!.id)}>Resume lesson</button>{/if}<button type="button" class="ghost" aria-label={savedLesson ? 'Resume daily review' : 'Start daily review'} disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => { void openTeacher() }}><span class="full-caption">{savedLesson ? 'Resume daily review' : 'Start daily review'}</span><span class="compact-caption">{savedLesson ? 'Resume daily review' : 'Start daily review'}</span></button><button type="button" class="ghost" aria-label={teacherPortraits ? 'Hide teacher portrait' : 'Show teacher portrait'} disabled={!ready || streaming || graphBusy || startingRequest} onclick={() => void togglePortraits()}><span class="full-caption">{teacherPortraits ? 'Hide teacher portrait' : 'Show teacher portrait'}</span><span class="compact-caption">Portrait {teacherPortraits ? 'on' : 'off'}</span></button>{#if recallProtected}<span class="vl-status">Recall in progress — source material is hidden.</span>{/if}</div>
        {#if !modal && branchSelection?.items.length}<p class="vl-status" role="status">{branchSelection.items.length} {branchSelection.items.length === 1 ? 'phrase' : 'phrases'} saved for practice.</p>{/if}
        {#if recallProtected}
          <button type="button" class="ghost" onclick={() => requestSourceAction(() => { modal = null })}>Open conversation with help</button>
        {:else}
        <textarea
          class="nodrag nopan"
          placeholder="Reply from the selected node… Ctrl+Enter to send"
          bind:value={draft}
          onkeydown={onKeydown}
          disabled={streaming || graphBusy || startingRequest || !ready || workspace.status === 'conflict'}
          aria-label="Message to Zheng"
        ></textarea>
        <div class="vl-row">
          {#if streaming}
            <button type="button" onclick={stop}>Stop</button>
          {:else}
            <button type="submit" disabled={prerecorded || !draft.trim() || graphBusy || startingRequest || !ready || workspace.status === 'conflict'}>Send</button>
          {/if}
          <span class="vl-status">continues from the selected node (or the last one) · Ctrl+Enter sends</span>
        </div>
        {/if}
        </div>
      </form>
      {/if}
    </section>
</div>

{#if !modal && !languageSetupOpen && !recallProtected && (readingFocusNode?.type === 'assistant' || readingFocusNode?.type === 'chunk')}{#key readingFocusNode.id}<ResponseReader nodeId={readingFocusNode.id} text={readingFocusNode.data.text} passage={readingFocusNode.type === 'chunk'} originalWordSegments={readingFocusNode.type === 'chunk' ? readingFocusNode.data.originalWordSegments : undefined} onClose={() => { readingFocusId = undefined }} />{/key}{/if}

{#if modal === 'lessons'}<LessonsDialog {workspace} onChanged={applySaved} onOpen={(sessionId, anchorId) => { practiceAnchorId = anchorId; practiceSessionId = sessionId; practiceItemId = undefined; practiceAutoStart = true; modal = 'conversation-practice' }} onCreate={() => { void openDiscovery() }} onClose={() => { modal = null }} />
{:else if modal === 'conversation-practice'}<LessonDialog {workspace} {settings} anchorId={practiceAnchorId} initialSessionId={practiceSessionId} initialItemId={practiceItemId} autoStart={practiceAutoStart} onChanged={applySaved} onClose={() => { modal = null }} onReturn={id => { modal = null; if (workspace.snapshot?.state.nodes.some(n => n.id === id)) void revealNode(id) }} onDailyReview={() => { void openTeacher() }} onLessons={() => { modal = 'lessons' }} />
{:else if modal === 'providers'}<SettingsDialog {settings} allowNetwork={!prerecorded} onSave={async (value) => {
  settings = value
  if (!ready) throw new Error('The local workspace is not open. Reopen Settings after loading to save backup preferences.')
  const preferences = publicProviderPreferences(value)
  await workspace.mutate('provider-preferences', preferences, state => { state.preferences = preferences as Workspace['preferences'] })
  status = 'Provider settings saved.'
}} onClose={() => { modal = null }} />
{:else if modal === 'settings'}<SettingsHub {workspace} onChanged={applySaved} portraits={teacherPortraits} onPortraits={togglePortraits} onProviders={() => { modal = 'providers' }} onAudio={() => { modal = null; languageSetupOpen = true }} onClose={() => { modal = null }} />
{:else if modal === 'topics'}<TopicsDialog {workspace} onChanged={applySaved} onReveal={id => { void revealNode(id) }} onClose={() => { modal = null }} />
{:else if modal === 'more'}<Modal title="More tools" onClose={() => { modal = null }}>
  <div class="utility-options">
    <button type="button" class="ghost" aria-label="Backup & restore" onclick={() => { void openData() }}><strong>Backup & restore</strong><span>Download a copy of your workspace or restore saved data.</span></button>
    <button type="button" class="ghost" aria-label="Install app" onclick={() => { modal = 'pwa' }}><strong>Install app</strong><span>Keep Visual Language on your device’s home screen.</span></button>
    <button type="button" class="ghost" aria-label="App updates" onclick={() => { modal = 'pwa' }}><strong>App updates</strong><span>Check for a new version and save before updating.</span></button>
    <button type="button" class="ghost" aria-label="About" onclick={() => { modal = 'about' }}><strong>About</strong><span>Project information and credits.</span></button>
    <button type="button" class="ghost" aria-label="Demo workspace" onclick={() => { void openDemo() }}><strong>Demo workspace</strong><span>Explore sample conversations and practice with saved examples.</span></button>
  </div>
</Modal>
{:else if modal === 'about'}<AboutDialog onClose={() => { modal = null }} />
{:else if modal === 'data'}<DataDialog {workspace} {flushDraft} onRestored={applySaved} onClose={() => { modal = null }} />
{:else if modal === 'capture'}<CaptureDialog {workspace} sourceNodeId={captureNodeId} selectedText={captureText} selectedMeaning={captureMeaning} readingDetails={captureDetails} onSaved={snapshot => { applySaved(snapshot); status = 'Saved for practice.' }} onClose={() => { modal = null }} />
{:else if modal === 'library'}<LibraryDialog {workspace} initialSection={librarySection} {readingDraftId} onHistory={id => { void openHistory(id) }} onPractice={id => { void openTeacher(id) }} onCapture={() => { void openCapture() }} onReveal={id => { void revealNode(id) }} onChanged={applySaved} onClose={() => { modal = null }} />
{:else if modal === 'teacher'}<TeacherDialog {workspace} {settings} {targetCardId} onHistory={id => { void openHistory(id) }} onChanged={applySaved} onReveal={id => { void revealNode(id) }} onClose={() => { modal = null }} />
{:else if modal === 'history'}<ReviewHistoryDialog {workspace} {settings} cardId={targetCardId} onChanged={applySaved} onPractice={id => { void openTeacher(id) }} onReveal={id => { void revealNode(id) }} onClose={() => { modal = null }} />
{:else if modal === 'search'}<SearchDialog {workspace} {settings} onReveal={id => { void revealNode(id) }} onPractice={id => { void openTeacher(id) }} onChanged={applySaved} onClose={() => { modal = null }} />
{:else if modal === 'pwa'}<PwaDialog {pwa} onPrepareUpdate={prepareUpdate} onClose={() => { modal = null }} />
{:else if modal === 'graph'}<GraphToolsDialog {workspace} {settings} nodeId={graphNodeId} onChanged={applySaved} onReveal={id => { void revealNode(id) }} onRegenerate={id => { void generateReply(id) }} onClose={() => { modal = null }} />
{:else if modal === 'delete-node' && deleteNodeScope}<Modal title="Delete node?" onClose={() => { if (!graphBusy) { modal = null; deleteNodeId = undefined; deleteNodeScope = undefined } }}><p>This removes this node{deleteNodeScope.nodeIds.length > 1 ? ` and ${deleteNodeScope.nodeIds.length - 1} connected ${deleteNodeScope.nodeIds.length === 2 ? 'node' : 'nodes'} below it` : ''} from the canvas. Saved learning history is kept.</p><div class="delete-node-actions"><button type="button" class="danger-button" disabled={graphBusy} onclick={confirmDeleteNode}>{graphBusy ? 'Deleting…' : 'Delete node'}</button><button type="button" class="ghost" disabled={graphBusy} onclick={() => { modal = null; deleteNodeId = undefined; deleteNodeScope = undefined }}>Cancel</button></div></Modal>
{:else if modal === 'demo'}<DemoDialog {workspace} {flushDraft} onChanged={applySaved} onSwitch={switchWorkspace} onClose={() => { modal = null }} />
{:else if modal === 'discovery'}<DiscoveryDialog {workspace} {settings} draftId={discoveryDraftId} onChanged={applySaved} onLesson={(id, sessionId) => { void openConversationPractice(sessionId, id, undefined, Boolean(sessionId)) }} onDailyReview={() => { void openTeacher() }} onReveal={id => { void revealNode(id) }} onSettings={() => { modal = 'providers' }} onClose={() => { modal = null }} />
{:else if modal === 'source-help'}<Modal title="Reveal learning material?" onClose={() => { if (!helpBusy) { modal = null; pendingSourceAction = undefined } }}><p>A recall question is still pending. Opening source text, pinyin, the library, or search can reveal its answer.</p>{#if protectedLessonReview}<p>Continuing records help for unanswered lesson checks. Your submitted first answers are kept. You can finish, then retry with a fresh check to earn the point.</p>{:else}<p>Continuing records one not-recalled review: box 1, next review one day from this help request. Later answers to this question are practice. This is a learning aid, not an examination restriction.</p>{/if}<div class="source-help-actions"><button type="button" onclick={confirmSourceHelp} disabled={helpBusy}>Reveal material and record help</button><button type="button" class="ghost" disabled={helpBusy} onclick={returnToQuestion}>Return to the question</button></div>{#if helpError}<p role="alert">{helpError}</p>{/if}</Modal>{/if}

{#if languageSetupOpen}<LanguageSetupDialog onClose={() => { languageSetupOpen = false }} />{/if}

<style>
  .compact-caption { display: none; }
  .demo-entry { position: relative; z-index: 5; pointer-events: auto; min-height: 44px; background: #1a1d26; }
  .utility-options { display: grid; gap: 10px; }.utility-options button { display: grid; gap: 5px; text-align: left; padding: 14px; }.utility-options strong { font-size: 15px; color: #e8eaed; }.utility-options span { font-size: 13px; font-weight: 400; line-height: 1.5; }.utility-options button:hover { background: #263750; }
  .source-help-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .delete-node-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .danger-button { background: #9f3838; border-color: #d46a6a; }
  .workspace-layout { position: relative; width: 100%; height: 100dvh; }
  .teacher-panel { position: absolute; z-index: 6; left: 50%; bottom: max(12px, env(safe-area-inset-bottom)); transform: translateX(-50%); display: flex; flex-direction: column; width: min(720px, calc(100% - 24px)); max-height: 45dvh; min-height: 0; pointer-events: none; }
  .teacher-shortcuts { display: flex; flex-shrink: 0; gap: 8px; align-items: center; margin-bottom: 5px; }
  .teacher-shortcuts button { pointer-events: auto; }
  .teacher-shortcuts .teacher-toggle { margin: 0 0 0 auto; }
  .connection-entry { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; pointer-events: auto; }.connection-entry button { min-height: 44px; font-size: 13px; }.connection-entry .ghost { padding-inline: 8px; }
  .teacher-panel.needs-connection { max-height: calc(45dvh + 52px); }
  .connection-summary { display: block; pointer-events: auto; border: 0; padding: 4px 0; background: transparent; color: #a9c7ff; text-align: left; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; cursor: pointer; }
  .demo-badge { font-size: 11px; line-height: 1.5; color: #f0d494; border-left: 3px solid #bf984c; padding-left: 7px; overflow-wrap: anywhere; }
  .canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .canvas :global(.svelte-flow__handle) { cursor: default; }

  .brand {
    min-width: 220px;
    max-width: min(380px, 70vw);
    overflow-wrap: anywhere;
    pointer-events: none;
    box-shadow: none;
    background: #1a1d2666;
    border-color: #2c334077;
  }
  :global(.svelte-flow__panel.background-status) { z-index: auto; pointer-events: none; }
  /* Do not create a stacking context around the background status. Recovery
     actions are exceptional foreground controls; About lives in the tool rail. */
  .status-actions { position: relative; z-index: 5; pointer-events: auto; margin-top: 8px; max-width: min(380px, calc(100vw - 104px)); }

  .composer {
    width: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  }
  .teacher-dialogue { display: flex; flex-direction: row; align-items: end; gap: 12px; border-color: #58749e; pointer-events: auto; }
  .teacher-content { flex: 1; min-width: 0; }
  .teacher-content h3 { margin: 0 0 8px; color: #9ec4ff; }
  .teacher-content h3 span { font-size: 12px; color: #929bae; font-weight: 400; }
  .teacher-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }.teacher-actions button { font-size: 12px; padding: 5px 9px; }
  .teacher-toggle { display: block; margin: 0 0 5px auto; background: #1a1d26; padding: 6px 12px; border: 1px solid #465773; border-radius: 8px; color: #9ec4ff; }
  .save-error { color: #f4a3a3; font-size: 12px; max-height: 100px; overflow: auto; }
  @media (max-width: 880px) {
    :global(.svelte-flow__panel.svelte-flow__controls.bottom) { bottom: calc(var(--teacher-height) + max(12px, env(safe-area-inset-bottom)) + 8px); margin-bottom: 0; }
    :global(.svelte-flow__minimap) { display: none; }
  }
  @media (max-width: 640px) {
    .brand { min-width: 0; width: calc(100vw - 104px); max-width: none; max-height: 28dvh; overflow-y: auto; gap: 4px; padding: 8px 10px; }
    .brand p { margin: 0; } .brand .vl-status { font-size: 10px; }
    .teacher-content h3 span { display: none; }
    .full-caption { display: none; } .compact-caption { display: inline; }
    .teacher-dialogue { display: grid; grid-template-columns: 1fr; gap: 6px 8px; align-items: start; }
    .teacher-dialogue.has-portrait { grid-template-columns: 64px minmax(0, 1fr); }
    .teacher-dialogue :global(.portrait.strip) { width: 64px; height: 64px; grid-row: 1 / 3; grid-column: 1; }
    .teacher-content { display: contents; }
    .teacher-content h3 { grid-row: 1; margin: 0; font-size: 16px; line-height: 24px; }
    .teacher-actions { grid-row: 2; gap: 4px; margin: 0; }
    .teacher-actions button { min-height: 36px; padding: 4px 6px; font-size: 11px; }
    .has-portrait .teacher-content h3, .has-portrait .teacher-actions { grid-column: 2; }
    .teacher-content textarea, .teacher-content .vl-row, .teacher-content > button { grid-column: 1 / -1; }
    .teacher-content textarea { min-height: 56px; }
    .teacher-content .vl-row button { min-height: 44px; }
    .teacher-panel { width: calc(100% - 16px); }
    .teacher-shortcuts button { min-height: 44px; }
    :global(.svelte-flow__minimap) { display: none; }
  }
</style>
