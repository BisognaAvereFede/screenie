# Screenie

Client SSH per gestire un server Ubuntu: terminale, sessioni `screen`, file via SFTP ed editor con salvataggio automatico.

## Avvio

Serve [Node.js](https://nodejs.org) (già installato su questo PC).

```bash
npm install
npm start
```

Al primo avvio Electron scarica il proprio eseguibile (circa 100 MB, una sola volta).

Al primo avvio la Home propone di aggiungere un server o di importarli da `~/.ssh/config`.
Se il server è già nei `~/.ssh/known_hosts` con la stessa chiave, Screenie si fida senza chiedere conferma.

## Installer Windows

```bash
npm run dist:win
```

Crea `release/Screenie-Setup-<versione>.exe`. L'installazione è per l'utente corrente, senza permessi di amministratore, e crea i collegamenti sul desktop e nel menu Start.
Per il Mac c'è `npm run dist:mac`, che va lanciato su un Mac.

Il generatore dell'installer (NSIS) non funziona con percorsi più lunghi di circa 260 caratteri. Se si blocca con `could not open file … .nsh`, sposta il progetto in una cartella con un percorso corto.

## Cosa fa

- **Server**: aggiungili con il `+` a sinistra (host, utente, chiave privata). Doppio clic per connetterti. Se la connessione non riesce, l'errore resta sul server con il pulsante *Riprova*.
- **Screen** (pannello a destra):
  - scrivi un nome e premi Invio per creare uno screen e aprirlo;
  - *Apri* lo aggancia in una scheda (se è agganciato altrove, lo porta qui);
  - *Stacca*, o la chiusura della scheda, lo lascia in esecuzione sul server;
  - *Termina* lo chiude, dopo una conferma.

  Lo stato si aggiorna da solo ogni 4 secondi. Se `screen` non è installato, c'è un pulsante per installarlo.
- **File** (pannello a destra):
  - per caricare, trascina file o cartelle dal PC (anche sopra una cartella);
  - doppio clic per aprire una cartella o un file;
  - tasto destro per scaricare, rinominare, eliminare, copiare il percorso o aprire un terminale in quella cartella.

  I trasferimenti mostrano avanzamento e velocità.
- **Editor**:
  - salva automaticamente mentre scrivi (si può disattivare), `Ctrl+S` per salvare subito;
  - se il file è stato cambiato sul server da altri, non lo sovrascrive e ti chiede cosa fare.

  In alternativa, *Apri con editor esterno* lo apre nel tuo editor (VS Code, Notepad++…) e lo ricarica sul server a ogni salvataggio, come in MobaXterm.
- **Terminale**:
  - selezionando il testo lo copi, col tasto destro incolli; `Ctrl+Shift+C/V` funzionano; `Ctrl +/-` cambiano la dimensione del testo;
  - `Ctrl+Shift+F` cerca nel terminale, `Ctrl+Shift+E` / `Ctrl+Shift+O` lo dividono a destra o sotto (fino a 4 riquadri);
  - `Ctrl+Shift+A` scrive in tutti i terminali aperti insieme;
  - i comandi salvati (Impostazioni → Comandi salvati) si lanciano con un clic dal pulsante del terminale;
  - se la connessione cade, Screenie si riconnette da solo e riapre le sessioni.
- **Palette comandi** (`Ctrl+Shift+P`): cerca server, schede, screen, comandi salvati e azioni.
- **Server**: gruppi, ricerca (con più di 5 server), importazione da `~/.ssh/config`, jump host, agent SSH di Windows o Pageant, tunnel locali (`8080:localhost:80`), latenza e grafico di CPU e memoria.
- **Sessione**: all'avvio riapre i terminali, gli screen e i file dove li avevi lasciati.
- **Scorciatoie**: tutte modificabili in Impostazioni → Scorciatoie; `F1` mostra l'elenco.
- **Backup**: Impostazioni → Backup esporta e importa server, preferiti e impostazioni (senza passphrase).
- **Area di notifica**: l'icona di Screenie apre al volo un terminale su un server salvato.

## Sicurezza

- Si usa solo l'autenticazione a chiave (file, agent SSH o Pageant), con la libreria [ssh2](https://github.com/mscdex/ssh2), molto diffusa e collaudata.
- **Identità del server**: alla prima connessione ti viene mostrata l'impronta della chiave del server. Se l'impronta cambia, la connessione si blocca e appare un avviso.
- **Passphrase della chiave**: viene salvata solo se lo chiedi, cifrata dal sistema operativo (DPAPI su Windows, Portachiavi su macOS). La chiave privata non viene mai copiata.
- **Interfaccia isolata**: l'interfaccia non ha accesso diretto a file, rete o Node. Può fare solo le operazioni previste. Non apre pagine esterne e non si collega a nient'altro che ai tuoi server.
- **Eliminazioni protette**: l'eliminazione di `/`, della home e delle cartelle di primo livello (`/etc`, `/var`…) viene sempre rifiutata.

## Test

```bash
npx electron test/backend.test.js
```

Collauda connessione, passphrase, host key, screen, SFTP (con un file da 30 MB), tunnel, jump host, importazione da ssh config e backup. Usa un server SSH finto incluso in `test/fake-server.js`.
