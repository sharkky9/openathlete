import { useSetProviderCredentialsMutation } from '@/api/provider';
import { API_KEY_HELP_URL } from '@/components/connectors/api-key-providers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { m } from '@/paraglide/messages';
import { connectorProviderLabelMap } from '@/utils/label-map/core/connector-provider.label-map';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConnectorProvider } from '@openathlete/shared';

interface ApiKeyConnectDialogProps {
  provider: ConnectorProvider | null;
  onOpenChange: (open: boolean) => void;
  onConnected?: (provider: ConnectorProvider) => void;
}

export function ApiKeyConnectDialog({
  provider,
  onOpenChange,
  onConnected,
}: ApiKeyConnectDialogProps) {
  const [apiKey, setApiKey] = useState('');

  const setCredentialsMutation = useSetProviderCredentialsMutation({
    onSuccess: (_data, variables) => {
      toast.success(
        m.provider_connected_successfully({
          provider: connectorProviderLabelMap[variables.provider],
        }),
      );
      setApiKey('');
      onOpenChange(false);
      onConnected?.(variables.provider);
    },
    onError: (error) => {
      toast.error(error.message || m.failed_to_initiate_connection());
    },
  });

  const handleSubmit = () => {
    if (!provider || !apiKey.trim()) return;
    setCredentialsMutation.mutate({ provider, apiKey: apiKey.trim() });
  };

  const helpUrl = provider ? API_KEY_HELP_URL[provider] : undefined;

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) setApiKey('');
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {provider
              ? m.connect_provider_title({
                  provider: connectorProviderLabelMap[provider],
                })
              : ''}
          </DialogTitle>
          <DialogDescription>
            {m.provider_api_key_description()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="provider-api-key">{m.provider_api_key_label()}</Label>
          <Input
            id="provider-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSubmit();
            }}
          />
          {helpUrl && (
            <a
              href={helpUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline"
            >
              {m.provider_api_key_help_link()}
            </a>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!apiKey.trim() || setCredentialsMutation.isPending}
          >
            {m.connect()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
