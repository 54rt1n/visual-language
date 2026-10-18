<script lang="ts">
  import Modal from './Modal.svelte'
  import dictionary from '../mandarin/dictionarySnapshot.json'
  import pronunciation from '../mandarin/readingModelManifest.json'
  let { onClose }: { onClose: () => void } = $props()
  const local = (path: string) => `${import.meta.env.BASE_URL}${path}`
</script>

<Modal title="About Visual Language" {onClose}>
  <p class="intro">Explore Mandarin conversations word by word, with Zheng as your learning companion.</p>

  <section aria-labelledby="dictionary-credits">
    <h3 id="dictionary-credits">Dictionary credits</h3>
    <p><a href={dictionary.source} target="_blank" rel="noopener noreferrer">CC-CEDICT</a> is maintained by <strong>{dictionary.publisher}</strong> and provided under the <a href={dictionary.license} target="_blank" rel="noopener noreferrer">Creative Commons Attribution-ShareAlike 4.0 license (CC BY-SA 4.0)</a>.</p>
    <p>The original CEDICT credits Paul Andrew Denisowski, © 1997–1998. Our snapshot is dated {dictionary.date.slice(0, 10)} and contains {dictionary.entries.toLocaleString('en-US')} entries.</p>
    <p>The archive is unchanged. We index it for lookup and display numbered pinyin as tone marks. Saved words retain their original dictionary citation; learner-edited wording is identified separately. This dictionary license is separate from the application code.</p>
    <p><a href={local('dictionaries/NOTICE.txt')} target="_blank" rel="noopener noreferrer">Full dictionary and decompression notices</a> · <a href="https://cc-cedict.org/editor/editor.php" target="_blank" rel="noopener noreferrer">Contribute a dictionary correction</a></p>
  </section>

  <section aria-labelledby="pronunciation-credits">
    <h3 id="pronunciation-credits">Pronunciation and word data</h3>
    <p><a href="https://github.com/zh-lx/pinyin-pro" target="_blank" rel="noopener noreferrer">pinyin-pro</a> by zh-lx and contributors supplies basic pinyin (MIT). The <a href="https://github.com/chinese-data/pinyin-pro-data" target="_blank" rel="noopener noreferrer">pinyin-pro data project</a> supplies local lexical data (ISC).</p>
    <p>The optional contextual pinyin pack uses <a href="https://github.com/GitYCC/g2pW" target="_blank" rel="noopener noreferrer">G2pW</a> by GitYCC and contributors and Google's Chinese BERT vocabulary (Apache-2.0), with Microsoft's ONNX Runtime Web (MIT).</p>
    <p>Visual Language packs and quantizes its pronunciation predictor and transforms its metadata. The runtime files are unchanged. Viewing these credits does not download the optional contextual pinyin pack.</p>
    <p><a href={local(`${pronunciation.directory}NOTICE.txt`)} target="_blank" rel="noopener noreferrer">Model modifications and source credits</a> · <a href={local(`${pronunciation.directory}G2pW-LICENSE.txt`)} target="_blank" rel="noopener noreferrer">Apache license</a> · <a href={local(`${pronunciation.directory}ORT-LICENSE.txt`)} target="_blank" rel="noopener noreferrer">Runtime license</a> · <a href={local(`${pronunciation.directory}ORT-ThirdPartyNotices.txt`)} target="_blank" rel="noopener noreferrer">Runtime third-party notices</a></p>
  </section>

  <section aria-labelledby="project-credits">
    <h3 id="project-credits">Project and artwork</h3>
    <p>Visual Language is by Martin Bukowski. Application code uses the <a href="https://polyformproject.org/licenses/noncommercial/1.0.0" target="_blank" rel="noopener noreferrer">PolyForm Noncommercial License 1.0.0</a>. Zheng's portraits were AI-generated for this project.</p>
    <p>The interface uses Svelte and <a href="https://github.com/xyflow/xyflow" target="_blank" rel="noopener noreferrer">Svelte Flow</a>. Dictionary, model and other third-party licenses apply separately; no endorsement by their contributors is implied.</p>
  </section>
</Modal>

<style>
  .intro { margin-top: 0; color: #c6d2e6; }
  section + section { margin-top: 22px; padding-top: 16px; border-top: 1px solid #354154; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 8px 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  a { color: #a9ceff; text-underline-offset: 3px; }
</style>
