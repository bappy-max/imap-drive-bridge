# IMAP Drive Bridge

Connecteur minimal pour exposer à DOCK un **seul dossier métier** d'une boîte IMAP et fournir à n8n une passerelle SMTP interne strictement bornée.

## Garanties de conception

- connexion IMAPS avec validation TLS ;
- ouverture des dossiers IMAP en lecture seule ;
- aucune modification des drapeaux, aucun déplacement et aucune suppression d'email ;
- passerelle SMTP séparée, sans port public, avec expéditeur fixe et authentification par secret ;
- déduplication persistante des envois par `requestId` ;
- prise en charge de `In-Reply-To` et `References` pour les réponses dans le bon fil ;
- recherche limitée par date et mots-clés métier ;
- deux dossiers seulement : réception et envoyés ;
- état de déduplication local, sans contenu d'email dans les journaux ;
- transfert vers un webhook n8n authentifié ;
- aucun port Docker publié ;
- conteneur sans privilège, capacités Linux supprimées et système de fichiers en lecture seule.

## Architecture

`IONOS IMAP (lecture seule) → collecteur → n8n → dossier Google Drive privé → DOCK`

`DOCK (message validé) → n8n/MCP → passerelle SMTP interne → IONOS SMTP`

## Déploiement en deux phases

### 1. Découverte sûre

Le premier démarrage doit conserver `MODE=discover`. Il liste seulement les noms et attributs des dossiers IMAP afin d'identifier le dossier Envoyés. Il ne recherche et ne télécharge aucun message.

```bash
cp .env.example .env
chmod 600 .env
mkdir -p data
chown 1000:1000 data
install -d -m 700 /root/.dock-ionos-secrets
touch /root/.dock-ionos-secrets/imap_password /root/.dock-ionos-secrets/n8n_header
chmod 600 /root/.dock-ionos-secrets/imap_password /root/.dock-ionos-secrets/n8n_header
```

Renseigner localement dans `.env` uniquement :

- `IMAP_HOST`
- `IMAP_USER`
- `IMAP_PASSWORD_FILE` doit rester égal à `/run/secrets/imap_password`

Saisir le mot de passe IONOS directement dans `/root/.dock-ionos-secrets/imap_password`, sans le placer dans `.env`, GitHub, un ticket ou un chat. Le jeton du webhook n8n est conservé de la même manière dans `/root/.dock-ionos-secrets/n8n_header`.

Puis :

```bash
docker compose up -d --build
docker compose logs --tail=50
```

La preuve attendue est `mailbox_discovery_complete` avec `messageContentRead:false`.

### 2. Synchronisation bornée

Avant de passer à `MODE=sync` :

1. importer `n8n/workflow-template.json` dans n8n ;
2. créer une authentification d'en-tête n8n et la sélectionner sur le webhook ;
3. connecter Google Drive dans n8n ;
4. sélectionner le dossier Drive privé autorisé dans le nœud d'upload ;
5. activer le workflow ;
6. compléter `.env` avec les deux dossiers IMAP vérifiés, les mots-clés, la date minimale et le secret du webhook ;
7. remplacer `MODE=discover` par `MODE=sync`, puis recréer seulement ce conteneur.

Le connecteur exporte un fichier Markdown par message et chaque pièce jointe autorisée séparément. Les fichiers utilisent une date, la direction et un identifiant opaque ; les objets et correspondants ne figurent pas dans les noms de fichiers.

## Passerelle SMTP interne

Le service `dock-ionos-smtp` écoute uniquement sur le réseau Docker `root_default`. Il n'est jamais publié sur l'hôte. Le mot de passe de la boîte et le jeton n8n restent dans les fichiers Docker secrets existants.

Avant le premier démarrage :

```bash
install -d -o 1000 -g 1000 -m 700 smtp-data
```

Renseigner dans `.env` `SMTP_USER` et `SMTP_FROM` avec la même adresse IONOS. L'égalité est vérifiée au démarrage : le service ne peut pas changer d'expéditeur. La route `POST /v1/verify` teste l'authentification SMTP sans envoyer de message. La route `POST /v1/send` exige le jeton interne, un `requestId` unique, un objet et un corps texte. Les destinataires, tailles et pièces jointes sont limités par les variables `SMTP_MAX_*`.

Un `requestId` déjà vu n'est jamais renvoyé automatiquement. Si le premier essai est confirmé comme envoyé, un appel identique retourne le résultat mémorisé ; si son état est incertain ou en échec, un nouvel identifiant explicite est requis.

Après une remise SMTP confirmée, la passerelle ajoute la copie RFC822 exacte au dossier IMAP `Objets envoyés`. La remise SMTP est enregistrée avant cet archivage : un échec IMAP ne transforme donc jamais un email déjà parti en nouvel envoi à retenter. Une répétition du même `requestId` peut seulement reprendre l'archivage manquant, après contrôle du `Message-ID`, sans renvoyer l'email.

L'envoi effectif reste une action externe : le workflow MCP doit exiger la validation du destinataire, de l'objet et du corps exacts avant son exécution.

Importer ensuite `n8n/smtp-mcp-workflow.json`, sélectionner `Header Auth account 3` sur le Webhook et sur le nœud HTTP Request, puis publier le workflow. N'activer `Available in MCP` qu'après un test de validation et un test d'authentification SMTP sans envoi.

## Limites volontaires

- Les pièces jointes supérieures à `MAX_ATTACHMENT_BYTES` sont signalées mais non exportées.
- Les images intégrées aux signatures sont ignorées par défaut.
- Le filtre est une allowlist métier. Il ne faut jamais la remplacer par une synchronisation de toute la boîte.
- Le workflow n8n doit rester protégé par une authentification d'en-tête forte.
- La passerelle SMTP n'est pas une API publique et ne doit jamais recevoir de port hôte dans Docker Compose.
