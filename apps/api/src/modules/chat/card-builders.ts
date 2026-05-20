import { Env } from '../../config/env';

interface CardButton {
  text: string;
  onClick: {
    openLink?: { url: string };
    action?: { function: string; parameters: { key: string; value: string }[] };
  };
}

interface CardV2 {
  cardId: string;
  card: {
    header?: { title: string; subtitle?: string; imageUrl?: string };
    sections: { widgets: unknown[] }[];
  };
}

function taskDeepLink(taskId: string): string {
  return `${Env.APP_URL_INTERNAL}/tasks/${taskId}`;
}
function projectDeepLink(projectId: string): string {
  return `${Env.APP_URL_INTERNAL}/projects/${projectId}`;
}

function button(text: string, action: CardButton['onClick']): CardButton {
  return { text, onClick: action };
}

function actionButton(text: string, fnName: string, params: Record<string, string>): CardButton {
  return button(text, {
    action: {
      function: fnName,
      parameters: Object.entries(params).map(([key, value]) => ({ key, value })),
    },
  });
}

interface ChatPayload {
  recipientUserId: string;
  type: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  projectId: string | null;
}

export function buildCardForNotification(input: ChatPayload): CardV2 {
  const { type, payload, taskId, projectId } = input;
  const title = payload['title'] as string | undefined;
  const priority = payload['priority'] as string | undefined;

  switch (type) {
    case 'TaskAssigned':
      return {
        cardId: `task-assigned-${taskId}`,
        card: {
          header: { title: 'TASK ASSIGNED' },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `<b>${title ?? 'Task'}</b>` } },
                { decoratedText: { topLabel: 'Priority', text: priority ?? '—' } },
                {
                  buttonList: {
                    buttons: [
                      button('Open Task', { openLink: { url: taskDeepLink(taskId!) } }),
                      actionButton('Accept', 'task.accept', { taskId: taskId ?? '' }),
                      actionButton('Reassign…', 'task.reassign_dialog', { taskId: taskId ?? '' }),
                      actionButton('Mark Done', 'task.mark_done', { taskId: taskId ?? '' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'CommentAdded':
    case 'MentionedInComment': {
      const author = payload['authorName'] as string | undefined;
      const excerpt = payload['bodyPreview'] as string | undefined;
      return {
        cardId: `comment-${payload['commentId']}`,
        card: {
          header: {
            title: type === 'MentionedInComment' ? 'YOU WERE MENTIONED' : 'NEW COMMENT',
            subtitle: author ?? 'Someone',
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: excerpt ?? '(empty)' } },
                {
                  buttonList: {
                    buttons: [
                      button('Open Task', { openLink: { url: taskDeepLink(taskId!) } }),
                      actionButton('Reply…', 'task.reply_dialog', { taskId: taskId ?? '' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };
    }

    case 'TaskBlocked':
      return {
        cardId: `task-blocked-${taskId}`,
        card: {
          header: { title: 'TASK BLOCKED' },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `<b>${title ?? 'Task'}</b>` } },
                { decoratedText: { topLabel: 'Reason', text: (payload['reason'] as string) ?? '—' } },
                {
                  buttonList: {
                    buttons: [
                      button('Open Task', { openLink: { url: taskDeepLink(taskId!) } }),
                      actionButton('Unblock', 'task.unblock', { taskId: taskId ?? '' }),
                      actionButton('Comment…', 'task.reply_dialog', { taskId: taskId ?? '' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'TaskStatusChanged':
      return {
        cardId: `task-status-${taskId}`,
        card: {
          header: { title: 'STATUS CHANGED' },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    topLabel: 'Transition',
                    text: `${payload['fromStatus'] as string} → ${payload['toStatus'] as string}`,
                  },
                },
                {
                  buttonList: {
                    buttons: [button('Open Task', { openLink: { url: taskDeepLink(taskId!) } })],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'ClientReportedBug':
      return {
        cardId: `client-bug-${taskId}`,
        card: {
          header: { title: 'NEW CLIENT BUG' },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `<b>${title ?? 'Bug'}</b>` } },
                {
                  buttonList: {
                    buttons: [
                      button('Open Task', { openLink: { url: taskDeepLink(taskId!) } }),
                      actionButton('Acknowledge', 'task.acknowledge', { taskId: taskId ?? '' }),
                      actionButton('Assign to me', 'task.self_assign', { taskId: taskId ?? '' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'SprintStarted':
    case 'SprintCompleted':
      return {
        cardId: `sprint-${payload['sprintId']}-${type}`,
        card: {
          header: {
            title: type === 'SprintStarted' ? 'SPRINT STARTED' : 'SPRINT COMPLETED',
            subtitle: (payload['name'] as string) ?? '',
          },
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [button('Open Project', { openLink: { url: projectDeepLink(projectId!) } })],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'DeploymentSucceeded':
    case 'DeploymentFailed':
      return {
        cardId: `deploy-${payload['deploymentId']}`,
        card: {
          header: {
            title: type === 'DeploymentSucceeded' ? '✅ DEPLOYMENT SUCCEEDED' : '❌ DEPLOYMENT FAILED',
            subtitle: `${payload['environment'] as string} · ${payload['source'] as string}`,
          },
          sections: [
            {
              widgets: [
                { decoratedText: { topLabel: 'Commit', text: (payload['commitSha'] as string)?.slice(0, 7) ?? '—' } },
                {
                  buttonList: {
                    buttons: [button('Open Project', { openLink: { url: projectDeepLink(projectId!) } })],
                  },
                },
              ],
            },
          ],
        },
      };

    case 'DigestSummary': {
      // Consolidated digest card — one ping for N rolled-up events instead
      // of fanning out per item. The sink emits this with a `groupedCounts`
      // payload so the card stays small (and Chat truncates aggressively
      // beyond a few lines).
      const totalCount = (payload['totalCount'] as number | undefined) ?? 0;
      const counts = (payload['groupedCounts'] ?? {}) as {
        mentions?: number;
        assignments?: number;
        blocked?: number;
        dueSoon?: number;
        other?: number;
      };
      const lines: string[] = [];
      if (counts.mentions) lines.push(`• ${counts.mentions} mention${counts.mentions === 1 ? '' : 's'}`);
      if (counts.assignments) lines.push(`• ${counts.assignments} assignment${counts.assignments === 1 ? '' : 's'}`);
      if (counts.blocked) lines.push(`• ${counts.blocked} blocked`);
      if (counts.dueSoon) lines.push(`• ${counts.dueSoon} due soon / overdue`);
      if (counts.other) lines.push(`• ${counts.other} other`);
      return {
        cardId: `digest-summary-${payload['firstQueuedAt'] ?? Date.now()}`,
        card: {
          header: { title: 'NOCKTA DIGEST', subtitle: `${totalCount} update${totalCount === 1 ? '' : 's'}` },
          sections: [
            {
              widgets: [
                { textParagraph: { text: lines.join('<br>') || 'See inbox for details.' } },
                {
                  buttonList: {
                    buttons: [button('Open inbox', { openLink: { url: `${Env.APP_URL_INTERNAL}/notifications` } })],
                  },
                },
              ],
            },
          ],
        },
      };
    }

    default:
      return {
        cardId: `nf-${type}`,
        card: {
          header: { title: type },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `Notification: ${type}` } },
                ...(taskId
                  ? [
                      {
                        buttonList: {
                          buttons: [button('Open Task', { openLink: { url: taskDeepLink(taskId) } })],
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      };
  }
}
