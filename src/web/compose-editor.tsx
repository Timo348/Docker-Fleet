import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, FileCode, Play, RefreshCw, RotateCcw, Save, X } from 'lucide-react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/features/codicon/register.js';
import { validateComposeYaml } from '../shared/compose.js';
import type { ComposeFileResponse, Container } from '../shared/types.js';
import { getCompose, saveCompose } from './api.js';

const globalScope = globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: () => Worker;
  };
};
if (typeof window !== 'undefined' && !globalScope.MonacoEnvironment) {
  globalScope.MonacoEnvironment = {
    getWorker() {
      const blob = new Blob(['self.onmessage = function() {};'], {
        type: 'application/javascript',
      });
      return new Worker(URL.createObjectURL(blob));
    },
  };
}

let themeRegistered = false;
function ensureFleetTheme() {
  if (themeRegistered) return;
  themeRegistered = true;
  monaco.editor.defineTheme('docker-fleet-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'type', foreground: '86c9ed' },
      { token: 'keyword', foreground: '69c8f3' },
      { token: 'string', foreground: '86d8bf' },
      { token: 'number', foreground: 'dfc688' },
      { token: 'comment', foreground: '647c96' },
    ],
    colors: {
      'editor.background': '#0b111a',
      'editor.foreground': '#d4dae3',
      'editorLineNumber.foreground': '#587087',
      'editorLineNumber.activeForeground': '#9adafb',
      'editor.lineHighlightBackground': '#131d2a',
      'editor.selectionBackground': '#1b4b6b88',
      'editorCursor.foreground': '#69c8f3',
    },
  });
}

export interface ComposeEditorProps {
  target: Container;
  hostName: string;
  onClose: () => void;
  onSaved: (notice: string) => Promise<void> | void;
}

export function ComposeEditor({ target, hostName, onClose, onSaved }: ComposeEditorProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [meta, setMeta] = useState<ComposeFileResponse | null>(null);
  const [initialContent, setInitialContent] = useState('');
  const [content, setContent] = useState('');
  const [savingMode, setSavingMode] = useState<'save' | 'redeploy' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const syncingRef = useRef(false);

  const isDirty = Boolean(meta && content !== initialContent);

  const validation = useMemo(() => {
    if (!meta) return null;
    return validateComposeYaml(content);
  }, [content, meta]);

  const requestClose = useCallback(() => {
    if (savingMode) return;
    if (isDirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [savingMode, isDirty, confirmDiscard, onClose]);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, [requestClose]);

  const loadComposeFile = useCallback(async () => {
    if (!target.hostId) return;
    setLoading(true);
    setLoadError('');
    setSaveError('');
    setConfirmDiscard(false);
    try {
      const response = await getCompose(target.hostId, target.id);
      setMeta(response);
      setInitialContent(response.content);
      setContent(response.content);
      if (modelRef.current && modelRef.current.getValue() !== response.content) {
        syncingRef.current = true;
        modelRef.current.setValue(response.content);
        syncingRef.current = false;
      }
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [target.hostId, target.id]);

  useEffect(() => {
    void loadComposeFile();
  }, [loadComposeFile]);

  useEffect(() => {
    if (loading || loadError || !meta || !editorHostRef.current) return;
    ensureFleetTheme();
    const uri = monaco.Uri.parse(
      `inmemory://docker-fleet/${encodeURIComponent(target.hostId || 'host')}/${encodeURIComponent(meta.project)}/${encodeURIComponent(meta.fileName)}`,
    );
    const existingModel = monaco.editor.getModel(uri);
    const model = existingModel ?? monaco.editor.createModel(meta.content, 'yaml', uri);
    if (existingModel && existingModel.getValue() !== meta.content) {
      existingModel.setValue(meta.content);
    }
    modelRef.current = model;

    const editor = monaco.editor.create(editorHostRef.current, {
      model,
      theme: 'docker-fleet-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      renderLineHighlight: 'all',
      padding: { top: 12, bottom: 12 },
      ariaLabel: 'Compose YAML editor',
    });
    editorInstanceRef.current = editor;

    const sub = model.onDidChangeContent(() => {
      if (syncingRef.current) return;
      const next = model.getValue();
      setContent(next);
      setConfirmDiscard(false);
      setSaveError('');
    });

    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorInstanceRef.current = null;
      modelRef.current = null;
    };
  }, [loading, loadError, meta?.project, meta?.fileName, target.hostId]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || !validation) return;
    const lineCount = model.getLineCount();
    const markers: monaco.editor.IMarkerData[] = validation.errors.map((issue) => {
      const line = Math.min(Math.max(issue.line ?? 1, 1), lineCount);
      const col = Math.max(issue.column ?? 1, 1);
      return {
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: Math.max(col + 1, model.getLineMaxColumn(line)),
      };
    });
    monaco.editor.setModelMarkers(model, 'compose-yaml', markers);
  }, [validation]);

  const updateContentFromInput = (nextValue: string) => {
    setContent(nextValue);
    setConfirmDiscard(false);
    setSaveError('');
    if (modelRef.current && modelRef.current.getValue() !== nextValue) {
      syncingRef.current = true;
      modelRef.current.setValue(nextValue);
      syncingRef.current = false;
    }
  };

  const handleSave = async (redeploy: boolean) => {
    if (!target.hostId || !meta || savingMode) return;
    setSavingMode(redeploy ? 'redeploy' : 'save');
    setSaveError('');
    setConfirmDiscard(false);
    try {
      const saved = await saveCompose(target.hostId, target.id, {
        requestId: crypto.randomUUID(),
        content,
        redeploy,
        expectedRevision: meta.revision,
      });
      setMeta((prev) => (prev ? { ...prev, revision: saved.revision } : prev));
      setInitialContent(content);
      const notice = redeploy
        ? `Compose file (${saved.fileName}) for ${saved.project} on ${hostName} saved and stack redeployed.`
        : `Compose file (${saved.fileName}) for ${saved.project} on ${hostName} saved.`;
      await onSaved(notice);
      onClose();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSavingMode(null);
    }
  };

  return (
    <div className="overlay compose-overlay">
      <section
        className="compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-editor-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="compose-editor-title">
              <FileCode size={18} />
              Edit Compose · {meta?.project || target.composeProject || target.name}
              {isDirty && <span className="compose-dirty-badge">Unsaved changes</span>}
            </h2>
            <p>
              {hostName} · {meta?.fileName || 'docker-compose.yml'}
              {target.composeService ? ` · service: ${target.composeService}` : ''}
            </p>
          </div>
          <button
            className="icon-button"
            onClick={requestClose}
            disabled={savingMode !== null}
            aria-label="Close Compose editor"
          >
            <X size={19} />
          </button>
        </div>

        <div className="compose-toolbar">
          <span className="compose-status">
            {loading ? (
              <>
                <RefreshCw size={13} className="working" />
                Loading Compose file…
              </>
            ) : loadError ? (
              <>
                <CircleAlert size={13} />
                Compose file unavailable
              </>
            ) : validation?.valid ? (
              <>
                <Check size={13} />
                YAML valid · {validation.services.length}{' '}
                {validation.services.length === 1 ? 'service' : 'services'} (
                {validation.services.join(', ')})
              </>
            ) : (
              <>
                <CircleAlert size={13} />
                {validation?.message || 'Invalid YAML syntax'}
              </>
            )}
          </span>
          {meta && !loading && !loadError && (
            <button
              type="button"
              disabled={!isDirty || savingMode !== null}
              onClick={() => updateContentFromInput(initialContent)}
              title="Revert unsaved edits"
            >
              <RotateCcw size={13} />
              Reset changes
            </button>
          )}
        </div>

        {confirmDiscard && (
          <div className="message error compose-unsaved-warning" role="alert">
            <CircleAlert size={15} />
            <span>You have unsaved changes in this Compose file. Discard changes and close?</span>
            <div className="compose-warning-actions">
              <button type="button" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button type="button" className="danger-button" onClick={onClose}>
                Discard changes
              </button>
            </div>
          </div>
        )}

        {loadError && (
          <div className="message error" role="alert">
            <CircleAlert size={15} />
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadComposeFile()}>
              Retry
            </button>
          </div>
        )}

        {saveError && (
          <div className="message error" role="alert">
            <CircleAlert size={15} />
            <span>{saveError}</span>
            <button
              type="button"
              className="icon-button"
              onClick={() => setSaveError('')}
              aria-label="Dismiss save error"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="compose-editor-body">
          {loading && (
            <div className="compose-loading">
              <RefreshCw size={20} className="working" />
              <p>Retrieving {target.composeProject || target.name} Compose file from agent…</p>
            </div>
          )}
          {!loading && !loadError && meta && (
            <>
              <div
                ref={editorHostRef}
                className="compose-monaco-host"
                data-testid="monaco-compose-editor"
              />
              <textarea
                aria-label="Compose YAML content"
                className="compose-sr-textarea"
                value={content}
                onChange={(e) => updateContentFromInput(e.target.value)}
                spellCheck={false}
              />
            </>
          )}
        </div>

        <div className="compose-foot">
          <span className="muted">
            {meta
              ? `Stack: ${meta.project} · File: ${meta.fileName}`
              : 'Validated over mTLS agent connection'}
          </span>
          <div className="compose-actions">
            <button type="button" onClick={requestClose} disabled={savingMode !== null}>
              Cancel
            </button>
            <button
              type="button"
              disabled={loading || !!loadError || savingMode !== null}
              onClick={() => void handleSave(false)}
            >
              {savingMode === 'save' ? (
                <RefreshCw size={14} className="working" />
              ) : (
                <Save size={14} />
              )}
              {savingMode === 'save' ? 'Saving…' : 'Save only'}
            </button>
            <button
              type="button"
              className="primary"
              disabled={loading || !!loadError || savingMode !== null}
              onClick={() => void handleSave(true)}
            >
              {savingMode === 'redeploy' ? (
                <RefreshCw size={14} className="working" />
              ) : (
                <Play size={14} />
              )}
              {savingMode === 'redeploy' ? 'Redeploying…' : 'Save & Redeploy'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
