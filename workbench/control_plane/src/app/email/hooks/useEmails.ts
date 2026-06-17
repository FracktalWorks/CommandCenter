"use client";

import { useCallback } from "react";
import { useEmailStore } from "../lib/emailStore";

/**
 * Convenience hook wrapping the email list Zustand store.
 * Selectively picks only the email-related slice to avoid
 * unnecessary re-renders from accounts/compose state changes.
 */
export function useEmails() {
  const emails = useEmailStore((s) => s.emails);
  const emailsLoading = useEmailStore((s) => s.emailsLoading);
  const selectedEmailId = useEmailStore((s) => s.selectedEmailId);
  const selectedFolder = useEmailStore((s) => s.selectedFolder);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const searchQuery = useEmailStore((s) => s.searchQuery);
  const error = useEmailStore((s) => s.error);
  const folders = useEmailStore((s) => s.folders);

  const fetchEmails = useEmailStore((s) => s.fetchEmails);
  const selectEmail = useEmailStore((s) => s.selectEmail);
  const selectFolder = useEmailStore((s) => s.selectFolder);
  const setSearchQuery = useEmailStore((s) => s.setSearchQuery);
  const updateEmail = useEmailStore((s) => s.updateEmail);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);

  const selectedEmail = emails.find((e) => e.id === selectedEmailId) ?? null;
  const unreadCount = emails.filter(
    (e) => e.folder === selectedFolder && !e.isRead
  ).length;

  const loadEmails = useCallback(() => {
    if (selectedAccountId) {
      fetchEmails();
    }
  }, [selectedAccountId, fetchEmails]);

  return {
    emails,
    emailsLoading,
    selectedEmail,
    selectedEmailId,
    selectedFolder,
    selectedAccountId,
    searchQuery,
    error,
    folders,
    unreadCount,
    selectEmail,
    selectFolder,
    setSearchQuery,
    updateEmail,
    deleteEmail,
    loadEmails,
  };
}
