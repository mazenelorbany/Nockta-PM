import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { Section } from './Section';
import type { Attachment } from './types';
import { apiErrorMessage, formatBytes } from './utils';

export function AttachmentsSection({ taskId, projectId }: { taskId: string; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const attachmentsQuery = useQuery({
    queryKey: ['attachments', taskId],
    queryFn: () =>
      api.get<Attachment[]>(`/attachments?parentType=Task&parentId=${taskId}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/attachments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attachments', taskId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });

  async function uploadFile(file: File): Promise<void> {
    setUploading(true);
    try {
      // Step 1 — request a signed upload URL.
      const signed = await api.post<{ uploadId: string; uploadUrl: string; storageKey: string }>(
        '/attachments/sign',
        {
          parentType: 'Task',
          parentId: taskId,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        },
      );

      // Step 2 — PUT the bytes directly to the signed URL.
      const putResp = await fetch(signed.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!putResp.ok) throw new Error(`Upload failed: HTTP ${putResp.status}`);

      // Step 3 — confirm with the API so it creates the Attachment row.
      await api.post('/attachments/confirm', {
        uploadId: signed.uploadId,
        storageKey: signed.storageKey,
        parentType: 'Task',
        parentId: taskId,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      toast.success(`Uploaded ${file.name}`);
      void queryClient.invalidateQueries({ queryKey: ['attachments', taskId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onSelect(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  }

  async function onDownload(id: string): Promise<void> {
    try {
      const resp = await api.get<{ url: string }>(`/attachments/${id}/download`);
      window.open(resp.url, '_blank', 'noopener');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Download failed'));
    }
  }

  const items = attachmentsQuery.data ?? [];

  return (
    <Section title={`Attachments (${items.length})`}>
      <div className="space-y-2">
        {items.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2 text-sm"
          >
            <button
              type="button"
              onClick={() => onDownload(a.id)}
              className="flex items-center gap-2 min-w-0 hover:text-brand transition-colors"
            >
              <AttachmentIcon mime={a.mimeType} />
              <span className="truncate">{a.originalFilename}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatBytes(a.sizeBytes)}
              </span>
              {a.scanStatus === 'pending' && (
                <span className="text-xs text-priority-high">Scanning…</span>
              )}
              {a.scanStatus === 'infected' && (
                <span className="text-xs text-destructive">Quarantined</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete ${a.originalFilename}?`)) {
                  deleteMutation.mutate(a.id);
                }
              }}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              Delete
            </button>
          </div>
        ))}
        {items.length === 0 && !attachmentsQuery.isLoading && (
          <div className="text-xs text-muted-foreground">No attachments yet.</div>
        )}
        <label className="inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-background/30 px-3 py-2 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground cursor-pointer transition-colors w-full justify-center">
          <input
            ref={fileInputRef}
            type="file"
            onChange={onSelect}
            disabled={uploading}
            className="hidden"
          />
          {uploading ? 'Uploading…' : '+ Attach a file'}
        </label>
      </div>
      <span className="sr-only" aria-hidden>{projectId}</span>
    </Section>
  );
}

export function AttachmentIcon({ mime }: { mime: string }): JSX.Element {
  const m = mime || '';
  let glyph = '📎';
  if (m.startsWith('image/')) glyph = '🖼';
  else if (m.startsWith('video/')) glyph = '🎬';
  else if (m === 'application/pdf') glyph = '📄';
  else if (m.startsWith('text/')) glyph = '📝';
  return <span className="text-base" aria-hidden="true">{glyph}</span>;
}
