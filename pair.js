import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, jidNormalizedUser } from '@whiskeysockets/baileys';
import { upload } from './mega.js';

const router = express.Router();

// Configuration
const CLEANUP_DELAY = 2000;
const MAX_RETRIES = 3;

// Stockage des sessions actives
const activeSessions = new Map();

// Fonction utilitaire pour supprimer un fichier
async function removeFile(filePath) {
    try {
        await fs.rm(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`Erreur suppression:`, error.message);
        return false;
    }
}

// Génération d'ID sécurisé
function generateSecureId(length = 10) {
    return crypto.randomBytes(length).toString('hex');
}

// Nettoyage des event listeners
function cleanupEventListeners(socket, events) {
    events.forEach(event => {
        socket.ev.removeAllListeners(event);
    });
}

// Route principale - Version qui envoie le code IMMÉDIATEMENT
router.get('/', async (req, res) => {
    let num = req.query.number;
    let sessionId = generateSecureId();
    const sessionDir = path.join('./sessions', sessionId);
    
    // Nettoyer le numéro
    num = num?.replace(/[^0-9]/g, '');
    
    if (!num || num.length < 10) {
        return res.status(400).json({ error: 'Numéro invalide' });
    }
    
    console.log(`[${sessionId}] Démarrage pour ${num}`);
    
    try {
        // Créer le dossier de session
        await fs.mkdir(sessionDir, { recursive: true });
        
        // Configurer l'auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // Créer le socket
        const GlobalTechInc = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
        });
        
        // Stocker la session
        activeSessions.set(sessionId, {
            socket: GlobalTechInc,
            saveCreds,
            sessionDir,
            phoneNumber: num,
            createdAt: Date.now()
        });
        
        // Demander le code de pairage IMMÉDIATEMENT
        if (!GlobalTechInc.authState.creds.registered) {
            await delay(2000); // Petit délai comme dans l'original
            const code = await GlobalTechInc.requestPairingCode(num);
            
            // Envoyer le code dans la réponse IMMÉDIATEMENT
            console.log(`[${sessionId}] Code envoyé:`, code);
            
            if (!res.headersSent) {
                return res.json({ code: code });
            }
        } else {
            if (!res.headersSent) {
                return res.json({ status: 'already_registered' });
            }
        }
        
        // Gérer les événements de connexion
        GlobalTechInc.ev.on('creds.update', saveCreds);
        
        GlobalTechInc.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            
            if (connection === "open") {
                console.log(`[${sessionId}] Connecté!`);
                
                try {
                    await delay(10000);
                    
                    // Lire et uploader le fichier creds
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const credsContent = await fs.readFile(credsPath);
                    
                    // Upload vers Mega
                    const megaUrl = await upload(credsContent, `${sessionId}.json`);
                    let sessionString = megaUrl.replace('https://mega.nz/file/', '');
                    sessionString = "KERM-MD-V1~" + sessionString;
                    
                    // Envoyer la session
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    await GlobalTechInc.sendMessage(userJid, { text: sessionString });
                    
                    // Message de confirmation
                    await GlobalTechInc.sendMessage(userJid, { 
                        text: '☝🏽☝🏽☝🏽𝖪𝖤𝖱𝖬 𝖬𝖣 𝖵1 𝖲𝖤𝖲𝖲𝖨𝖮𝖭 𝖨𝖲 𝖲𝖴𝖢𝖢𝖤𝖲𝖲𝖥𝖴𝖫𝖫𝖸 𝖢𝖮𝖭𝖭𝖤𝖢𝖳𝖤𝖣✅\n\n> 𝖣𝗈𝗇’𝗍 𝖲𝗁𝖺𝗋𝖾 𝖳𝗁𝗂𝗌 𝖲𝖾𝗌𝗌𝗂𝗈𝗇 𝖶𝗂𝗍𝗁 𝖲𝗈𝗆𝖾𝗈𝗇𝖾\n\n> 𝖩𝗈𝗂𝗇 𝖢𝗁𝖺𝗇𝗇𝖾𝗅 𝖭𝗈𝗐:https://whatsapp.com/channel/0029Vafn6hc7DAX3fzsKtn45\n\n\n> ©️𝖯𝖮𝖶𝖤𝖱𝖤𝖣 𝖡𝖸 𝖪𝖦𝖳𝖤𝖢𝖧' 
                    });
                    
                    // Nettoyer après envoi
                    await delay(100);
                    await removeFile(sessionDir);
                    activeSessions.delete(sessionId);
                    
                    // Ne pas utiliser process.exit() - juste fermer la connexion
                    await GlobalTechInc.end();
                    
                } catch (err) {
                    console.error(`[${sessionId}] Erreur post-connexion:`, err);
                }
                
            } else if (connection === 'close' && lastDisconnect && lastDisconnect.error?.output?.statusCode !== 401) {
                console.log(`[${sessionId}] Connexion fermée, reconnexion...`);
                
                // Retry avec limite
                const session = activeSessions.get(sessionId);
                if (session && session.retryCount < MAX_RETRIES) {
                    session.retryCount = (session.retryCount || 0) + 1;
                    activeSessions.set(sessionId, session);
                    await delay(10000);
                    // Relancer la connexion
                }
            }
        });
        
    } catch (err) {
        console.error(`[${sessionId}] Erreur:`, err);
        
        if (!res.headersSent) {
            res.status(503).json({ code: 'Service Unavailable' });
        }
        
        // Nettoyer
        await removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

// Route pour nettoyer les sessions orphelines
router.delete('/cleanup/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (session) {
        if (session.socket) {
            cleanupEventListeners(session.socket, ['connection.update', 'creds.update']);
            await session.socket.end();
        }
        await removeFile(session.sessionDir);
        activeSessions.delete(sessionId);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// Nettoyage automatique toutes les 5 minutes
setInterval(async () => {
    const now = Date.now();
    const EXPIRATION_TIME = 10 * 60 * 1000; // 10 minutes
    
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.createdAt > EXPIRATION_TIME) {
            console.log(`Nettoyage session expirée: ${sessionId}`);
            if (session.socket) {
                cleanupEventListeners(session.socket, ['connection.update', 'creds.update']);
                await session.socket.end();
            }
            await removeFile(session.sessionDir);
            activeSessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);

export default router;
