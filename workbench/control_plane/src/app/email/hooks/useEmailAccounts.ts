"use client";

import { useCallback } from "react";
import { useEmailStore } from "../lib/emailStore";

/**
 * Convenience hook wrapping the email accounts Zustand store slice.
 * Provides account list, selection, and account-level CRUD operations.
 */
export function useEmailAccounts() {
  const accounts = useEmailStore((s) => s.accounts);
  const accountsLoading = useEmailStore((s) => s.accountsLoading);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const error = useEmailStore((s) => s.error);

  const fetchAccounts = useEmailStore((s) => s.fetchAccounts);
  const selectAccount = useEmailStore((s) => s.selectAccount);
  const deleteAccount = useEmailStore((s) => s.deleteAccount);
  const triggerSync = useEmailStore((s) => s.triggerSync);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;

  const loadAccounts = useCallback(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  return {
    accounts,
    accountsLoading,
    selectedAccount,
    selectedAccountId,
    error,
    selectAccount,
    deleteAccount,
    triggerSync,
    loadAccounts,
  };
}
