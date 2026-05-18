export interface CommentTemplate {
  id: string;
  name: string;
  body: string;
  scope: 'workspace' | 'project';
  projectId: string | null;
}

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}
