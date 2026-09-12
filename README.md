# IMAP Drive Bridge

Connecteur minimal pour exposer à DOCK un **seul dossier métier** d'une boîte IMAP, sans SMTP et sans port public supplémentaire.

## Garanties de conception

- connexion IMAPS avec validation TLS ;
- ouverture des dossiers IMAP en lecture seule ;
- aucune modification des drapeaux, aucun déplacement et aucune suppression d'email ;
- aucun composant SMTP et aucun envoi d'email ;
- recherche limitée par date et mots-clés métier ;
- deux dossiers seulement : réception et envoyés ;
- état de déduplication local, sans contenu d'email dans les journaux ;
- transfert vers un webhook n8n authentifié ;
- aucun port Docker publié ;
- conteneur sans privilège, capacités Linux supprimées et système de fichiers en lecture seule.

## Architecture

`IONOS IMAP (lecture seule) → ce conteneur → webhook n8n authentifié → dossier Google Drive privé → DOCK`

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

## Limites volontaires

- Les pièces jointes supérieures à `MAX_ATTACHMENT_BYTES` sont signalées mais non exportées.
- Les images intégrées aux signatures sont ignorées par défaut.
- Le filtre est une allowlist métier. Il ne faut jamais la remplacer par une synchronisation de toute la boîte.
- Le workflow n8n doit rester protégé par une authentification d'en-tête forte.
