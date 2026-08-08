import {
  useGetMyCoachedAthletesQuery,
  useGetMyCoachesQuery,
} from '@/api/athlete';
import { useGetMeQuery } from '@/api/user';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { m } from '@/paraglide/messages';
import { useMemo, useState } from 'react';

import { User } from '@openathlete/shared';

interface NewMessageThreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (participantUserIds: number[]) => void;
  isLoading?: boolean;
}

export function NewMessageThreadDialog({
  open,
  onOpenChange,
  onConfirm,
  isLoading = false,
}: NewMessageThreadDialogProps) {
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const { data: coaches } = useGetMyCoachesQuery();
  const { data: coachedAthletes } = useGetMyCoachedAthletesQuery();
  const { data: currentUser } = useGetMeQuery();

  // Combine coaches and athletes, excluding current user
  const availableUsers = useMemo(() => {
    const users: User[] = [];

    if (coaches) {
      users.push(...coaches);
    }

    if (coachedAthletes) {
      coachedAthletes.forEach((athlete) => {
        if (athlete.user) {
          users.push(athlete.user);
        }
      });
    }

    // Remove duplicates and current user
    const uniqueUsers = users.filter(
      (user, index, self) =>
        index === self.findIndex((u) => u.userId === user.userId) &&
        user.userId !== currentUser?.userId,
    );

    return uniqueUsers;
  }, [coaches, coachedAthletes, currentUser]);

  const handleToggleUser = (userId: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  };

  /**
   * The current user is always a participant, and selecting nobody else is
   * allowed: it creates a thread the user is alone in. That is deliberate —
   * `availableUsers` only ever contains the user's coaches and coached
   * athletes, so an account with neither used to face a permanently disabled
   * Create button and "0 conversations" forever. A solo thread is the smallest
   * thing the API already accepts (`participantUserIds` must contain the caller
   * and at least one entry), and other participants can be added later.
   */
  const handleConfirm = () => {
    if (currentUser?.userId) {
      const participantUserIds = [currentUser.userId, ...selectedUserIds];
      onConfirm(participantUserIds);
      setSelectedUserIds([]);
    }
  };

  const handleCancel = () => {
    setSelectedUserIds([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] z-[9999]">
        <DialogHeader>
          <DialogTitle>{m.chatbot_new_conversation()}</DialogTitle>
          <DialogDescription>
            {m.messages_new_thread_description()}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[400px]">
          <div className="space-y-2 p-2">
            {availableUsers.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <p className="text-sm">{m.messages_new_thread_no_people()}</p>
              </div>
            ) : (
              availableUsers.map((user) => (
                <div
                  key={user.userId}
                  className="flex items-center space-x-3 rounded-lg p-3 hover:bg-accent cursor-pointer"
                  onClick={() => handleToggleUser(user.userId)}
                >
                  <Checkbox
                    checked={selectedUserIds.includes(user.userId)}
                    onCheckedChange={() => handleToggleUser(user.userId)}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {user.firstName} {user.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            {m.cancel()}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!currentUser?.userId || isLoading}
            isLoading={isLoading}
          >
            {m.create()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
