import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Color, TextStyle, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, PilcrowLeft, PilcrowRight,
  Quote, Redo2, RemoveFormatting, Strikethrough, Underline, Undo2,
} from 'lucide-react';
import { sanitizeForEditor } from '../emailHtml';
import { classNames } from '../lib/format';

const COLORS = ['#1B1F22', '#5F6B73', '#B42318', '#B54708', '#017B66', '#175CD3', '#6941C6', '#C11574'];
const HIGHLIGHTS = ['#FEF0C7', '#D1FADF', '#D1E9FF', '#FCE7F6', '#EAECF0'];
const MAX_IMAGE = 5 * 1024 * 1024;

/** The signature lives in its own block so it can be swapped when the sender changes. */
const SignatureBlock = Node.create({
  name: 'signatureBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-signature]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-signature': 'true', class: 'signature-block' }), 0],
});

/** Quoted text of the message being answered. */
const QuoteBlock = Node.create({
  name: 'quoteBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-quote]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-quote': 'true', class: 'quote-block' }), 0],
});

export function setSignature(editor, html) {
  if (!editor) return;
  let signature = null;
  let quoteAt = null;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'signatureBlock') signature = { from: offset, to: offset + node.nodeSize };
    if (node.type.name === 'quoteBlock' && quoteAt === null) quoteAt = offset;
  });
  const block = html ? `<div data-signature="true">${sanitizeForEditor(html)}</div>` : null;
  const chain = editor.chain();
  if (signature && block) chain.insertContentAt(signature, block, { updateSelection: false }).run();
  else if (signature) chain.deleteRange(signature).run();
  else if (block) chain.insertContentAt(quoteAt ?? editor.state.doc.content.size, block, { updateSelection: false }).run();
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE) return reject(new Error('Images must be smaller than 5 MB.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function insertImageFiles(editor, files, onError) {
  const images = [...files].filter((file) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type));
  if (!images.length) return false;
  Promise.all(images.map(readImage))
    .then((sources) => sources.forEach((src) => editor.chain().focus().setImage({ src }).run()))
    .catch((error) => onError?.(error.message));
  return true;
}

function ToolButton({ active, disabled, onClick, title, children, className }) {
  return (
    <button type="button" className={classNames('tool', active && 'is-active', className)} onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-pressed={active || undefined}>
      {children}
    </button>
  );
}

function Swatches({ colors, onPick, onClear, clearLabel }) {
  return (
    <div className="swatches" role="menu">
      {colors.map((color) => <button key={color} type="button" style={{ background: color }} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(color)} aria-label={color} />)}
      <button type="button" className="swatch-clear" onMouseDown={(e) => e.preventDefault()} onClick={onClear}>{clearLabel}</button>
    </div>
  );
}

function Toolbar({ editor, t, onPickImage, compact }) {
  const [menu, setMenu] = useState(null);
  const [link, setLink] = useState('');
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'), link: e.isActive('link'),
      heading: e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      size: e.getAttributes('textStyle').fontSize || '',
      left: e.isActive({ textAlign: 'left' }), center: e.isActive({ textAlign: 'center' }), right: e.isActive({ textAlign: 'right' }),
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const run = (fn) => fn(editor.chain().focus()).run();
  const openLink = () => {
    setLink(editor.getAttributes('link').href || 'https://');
    setMenu(menu === 'link' ? null : 'link');
  };
  const applyLink = (event) => {
    event.preventDefault();
    const href = link.trim();
    if (!href || href === 'https://') run((c) => c.extendMarkRange('link').unsetLink());
    else if (/^(https?:|mailto:)/i.test(href)) run((c) => c.extendMarkRange('link').setLink({ href }));
    setMenu(null);
  };
  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t('formatting')}>
      {!compact && <>
        <ToolButton className="tool-history" title={`${t('undo')} (Ctrl+Z)`} disabled={!state.canUndo} onClick={() => run((c) => c.undo())}><Undo2 size={16} /></ToolButton>
        <ToolButton className="tool-history" title={`${t('redo')} (Ctrl+Y)`} disabled={!state.canRedo} onClick={() => run((c) => c.redo())}><Redo2 size={16} /></ToolButton>
        <span className="tool-sep tool-history" />
        <select className="tool-select" value={state.heading} onChange={(e) => run((c) => (e.target.value === 'p' ? c.setParagraph() : c.setHeading({ level: e.target.value === 'h2' ? 2 : 3 })))} title={t('textStyle')}>
          <option value="p">{t('normalText')}</option>
          <option value="h2">{t('heading')}</option>
          <option value="h3">{t('subheading')}</option>
        </select>
        <select className="tool-select narrow" value={state.size} onChange={(e) => run((c) => (e.target.value ? c.setFontSize(e.target.value) : c.unsetFontSize()))} title={t('textSize')}>
          <option value="12px">{t('sizeSmall')}</option>
          <option value="">{t('sizeNormal')}</option>
          <option value="18px">{t('sizeLarge')}</option>
          <option value="24px">{t('sizeHuge')}</option>
        </select>
        <span className="tool-sep" />
      </>}
      <ToolButton title={t('bold')} active={state.bold} onClick={() => run((c) => c.toggleBold())}><Bold size={16} /></ToolButton>
      <ToolButton title={t('italic')} active={state.italic} onClick={() => run((c) => c.toggleItalic())}><Italic size={16} /></ToolButton>
      <ToolButton title={t('underline')} active={state.underline} onClick={() => run((c) => c.toggleUnderline())}><Underline size={16} /></ToolButton>
      <ToolButton title={t('strike')} active={state.strike} onClick={() => run((c) => c.toggleStrike())}><Strikethrough size={16} /></ToolButton>
      <span className="tool-menu">
        <ToolButton title={t('textColor')} onClick={() => setMenu(menu === 'color' ? null : 'color')}><span className="color-glyph" style={{ '--glyph': editor.getAttributes('textStyle').color || 'currentColor' }}>A</span></ToolButton>
        {menu === 'color' && <Swatches colors={COLORS} clearLabel={t('automatic')} onPick={(color) => { run((c) => c.setColor(color)); setMenu(null); }} onClear={() => { run((c) => c.unsetColor()); setMenu(null); }} />}
      </span>
      <span className="tool-menu">
        <ToolButton title={t('highlight')} onClick={() => setMenu(menu === 'mark' ? null : 'mark')}><Highlighter size={16} /></ToolButton>
        {menu === 'mark' && <Swatches colors={HIGHLIGHTS} clearLabel={t('none')} onPick={(color) => { run((c) => c.setHighlight({ color })); setMenu(null); }} onClear={() => { run((c) => c.unsetHighlight()); setMenu(null); }} />}
      </span>
      <span className="tool-sep" />
      <ToolButton title={t('bulletList')} active={state.bullet} onClick={() => run((c) => c.toggleBulletList())}><List size={16} /></ToolButton>
      <ToolButton title={t('numberedList')} active={state.ordered} onClick={() => run((c) => c.toggleOrderedList())}><ListOrdered size={16} /></ToolButton>
      {!compact && <ToolButton title={t('quote')} active={state.quote} onClick={() => run((c) => c.toggleBlockquote())}><Quote size={16} /></ToolButton>}
      <span className="tool-sep" />
      <span className="tool-menu">
        <ToolButton title={t('paragraph')} active={state.center || state.left || state.right} onClick={() => setMenu(menu === 'align' ? null : 'align')}>
          {state.center ? <AlignCenter size={16} /> : state.right ? <AlignRight size={16} /> : <AlignLeft size={16} />}
        </ToolButton>
        {menu === 'align' && (
          <div className="menu tool-list" role="menu">
            {[
              [t('alignLeft'), AlignLeft, (c) => c.setTextAlign('left')],
              [t('alignCenter'), AlignCenter, (c) => c.setTextAlign('center')],
              [t('alignRight'), AlignRight, (c) => c.setTextAlign('right')],
              [t('rightToLeft'), PilcrowLeft, (c) => c.setTextDirection('rtl')],
              [t('leftToRight'), PilcrowRight, (c) => c.setTextDirection('ltr')],
            ].map(([label, Icon, command]) => (
              <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { run(command); setMenu(null); }}><Icon size={15} />{label}</button>
            ))}
          </div>
        )}
      </span>
      <span className="tool-sep" />
      <span className="tool-menu">
        <ToolButton title={t('insertLink')} active={state.link} onClick={openLink}><Link2 size={16} /></ToolButton>
        {menu === 'link' && (
          <form className="link-popover" onSubmit={applyLink}>
            <input autoFocus dir="ltr" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
            <button className="button primary small">{t('apply')}</button>
            {state.link && <button type="button" className="button ghost small" onClick={() => { run((c) => c.extendMarkRange('link').unsetLink()); setMenu(null); }}>{t('removeLink')}</button>}
          </form>
        )}
      </span>
      <ToolButton title={t('insertImage')} onClick={onPickImage}><ImagePlus size={16} /></ToolButton>
      <ToolButton title={t('clearFormatting')} onClick={() => run((c) => c.unsetAllMarks().clearNodes())}><RemoveFormatting size={16} /></ToolButton>
    </div>
  );
}

export default function RichEditor({ content, onChange, onReady, placeholder, t, compact = false, autoFocus = false, onError, className }) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    textDirection: 'auto',
    autofocus: autoFocus ? 'start' : false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['mailto'] }, heading: { levels: [2, 3] } }),
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder }),
      SignatureBlock,
      QuoteBlock,
    ],
    content,
    editorProps: {
      transformPastedHTML: (html) => sanitizeForEditor(html),
      handlePaste: (_view, event) => insertImageFiles(editorRef.current, event.clipboardData?.files || [], onError),
      handleDrop: (_view, event) => insertImageFiles(editorRef.current, event.dataTransfer?.files || [], onError),
      attributes: { class: 'rich-content', spellcheck: 'true' },
    },
    onUpdate: ({ editor: e }) => onChangeRef.current?.(e.getHTML(), e),
  });
  const editorRef = useRef(null);
  editorRef.current = editor;
  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickImage = async () => {
    try {
      const src = await window.emargy.pickImage();
      if (src) editor.chain().focus().setImage({ src }).run();
    } catch (error) {
      onError?.(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  if (!editor) return null;
  return (
    <div className={classNames('rich-editor', compact && 'compact', className)}>
      <Toolbar editor={editor} t={t} onPickImage={pickImage} compact={compact} />
      <EditorContent editor={editor} className="rich-body" />
    </div>
  );
}
