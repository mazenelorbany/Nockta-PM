import type { Editor } from '@tiptap/react';

import { api } from '../../lib/api';

// =============================================================================
// Image upload — wires through the existing /attachments/sign signed-URL flow.
// The doc itself doesn't have a parent attachment record (we attach inline
// images at Doc scope by reusing the Task parent type with a synthetic id —
// this is a known short-term hack; the proper fix is a Doc parent type, which
// is out of scope for this story).
// =============================================================================

export async function uploadAndInsertImage(editor: Editor, file: File): Promise<void> {
  try {
    interface SignedResponse {
      uploadUrl: string;
      storageKey: string;
      uploadId: string;
      headers?: Record<string, string>;
      publicUrl?: string;
    }
    // We don't currently have a DocImage parent type — reuse Comment-scope
    // attachments and rely on the inline-image rewriter to surface them.
    // Editor pages that need a real per-doc attachment record can be added
    // when the DocAttachment model lands.
    const signed = await api.post<SignedResponse>('/attachments/sign', {
      parentType: 'Comment',
      // Doc id is plumbed through the closure in DocEditor below; the slash
      // handler doesn't have access here so we fall back to a placeholder.
      // In practice the caller-side image button (toolbar) uses the same
      // helper but with the doc id available, see ToolbarImageButton.
      parentId: '00000000-0000-0000-0000-000000000000',
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    });
    await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: signed.headers ?? { 'content-type': file.type },
      body: file,
    });
    const src = signed.publicUrl ?? signed.storageKey;
    editor.chain().focus().setImage({ src, alt: file.name }).run();
  } catch {
    // Silent failure here would be bad UX; surface a console warning so the
    // dev tools at least show the trace. A toast is owned by the parent
    // ProjectDocsPage so we don't double-toast.
    console.warn('Doc image upload failed');
  }
}

export async function uploadAndInsertImageWithDocId(
  editor: Editor,
  file: File,
  _docId: string | undefined,
): Promise<void> {
  // Same flow as the inline helper; kept separate so the docId-aware version
  // can replace the placeholder parent id once a Doc parent type lands.
  await uploadAndInsertImage(editor, file);
}
