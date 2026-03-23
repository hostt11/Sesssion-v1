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

async function removeFile(filePath) {
    try {
        await fs.rm(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`Erreur suppression:`, error.message);
        return false;
    }
}

function generateSecureId(length = 10) {
    return crypto.randomBytes(length).toString('hex');
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let sessionId = generateSecureId();
    const sessionDir = path.join('./sessions', sessionId);
    
    num = num?.replace(/[^0-9]/g, '');
    
    if (!num || num.length < 10) {
        return res.status(400).json({ error: 'Numéro invalide' });
    }
    
    console.log(`[${sessionId}] Démarrage pour ${num}`);
    
    try {
        await fs.mkdir(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const GlobalTechInc = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
        });
        
        activeSessions.set(sessionId, {
            socket: GlobalTechInc,
            saveCreds,
            sessionDir,
            phoneNumber: num,
            createdAt: Date.now()
        });
        
        // Gérer la demande de code de pairage
        if (!GlobalTechInc.authState.creds.registered) {
            await delay(2000);
            
            // IMPORTANT: Le code doit être saisi sur le TÉLÉPHONE de l'utilisateur
            // Pas dans le bot !
            const code = await GlobalTechInc.requestPairingCode(num);
            
            console.log(`[${sessionId}] Code de pairage généré:`, code);
            
            // Envoyer le code à l'utilisateur via la réponse HTTP
            // L'utilisateur devra saisir ce code sur son téléphone
            if (!res.headersSent) {
                return res.json({ 
                    code: code,
                    instruction: "Saisissez ce code dans WhatsApp sur votre téléphone",
                    phoneNumber: num
                });
            }
        }
        
        // Gérer les événements de connexion
        GlobalTechInc.ev.on('creds.update', saveCreds);
        
        GlobalTechInc.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            
            if (connection === "open") {
                console.log(`[${sessionId}] Connecté avec succès!`);
                
                try {
                    await delay(10000);
                    
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const credsContent = await fs.readFile(credsPath);
                    
                    const megaUrl = await upload(credsContent, `${sessionId}.json`);
                    let sessionString = megaUrl.replace('https://mega.nz/file/', '');
                    sessionString = "KERM-MD-V1~" + sessionString;
                    
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    
                    // Envoyer la session à l'utilisateur
                    await GlobalTechInc.sendMessage(userJid, { text: sessionString });
                    
                    await GlobalTechInc.sendMessage(userJid, { 
                        text: '✅ *KERM MD V1 SESSION SUCCESSFUL* ✅\n\n' +
                              '⚠️ *IMPORTANT:* Ne partagez jamais cette session avec personne!\n\n' +
                              '📱 *Join Channel:* https://whatsapp.com/channel/0029Vafn6hc7DAX3fzsKtn45\n\n' +
                              '©️ KGTECH'
                    });
                    
                    await delay(100);
                    await removeFile(sessionDir);
                    activeSessions.delete(sessionId);
                    await GlobalTechInc.end();
                    
                } catch (err) {
                    console.error(`[${sessionId}] Erreur post-connexion:`, err);
                }
            }
        });
        
    } catch (err) {
        console.error(`[${sessionId}] Erreur:`, err);
        
        if (!res.headersSent) {
            res.status(503).json({ code: 'Service Unavailable', error: err.message });
        }
        
        await removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

// Route pour obtenir le code de pairage (version alternative)
router.get('/pairing-code', async (req, res) => {
    let num = req.query.number;
    num = num?.replace(/[^0-9]/g, '');
    
    if (!num || num.length < 10) {
        return res.status(400).json({ error: 'Numéro invalide' });
    }
    
    const sessionId = generateSecureId();
    const sessionDir = path.join('./sessions', sessionId);
    
    try {
        await fs.mkdir(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
        });
        
        // Générer le code de pairage
        await delay(2000);
        const code = await socket.requestPairingCode(num);
        
        // Stocker la socket pour usage ultérieur
        activeSessions.set(sessionId, {
            socket,
            saveCreds,
            sessionDir,
            phoneNumber: num,
            code: code,
            createdAt: Date.now()
        });
        
        socket.ev.on('creds.update', saveCreds);
        
        // Répondre immédiatement avec le code
        res.json({
            success: true,
            code: code,
            message: `Saisissez ce code dans WhatsApp sur votre téléphone ${num}`,
            sessionId: sessionId
        });
        
        // Configurer l'écoute de connexion
        socket.ev.on("connection.update", async (s) => {
            const { connection } = s;
            
            if (connection === "open") {
                console.log(`Session ${sessionId} connectée!`);
                
                // Une fois connecté, uploader et envoyer la session
                await delay(5000);
                
                try {
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const credsContent = await fs.readFile(credsPath);
                    
                    const megaUrl = await upload(credsContent, `${sessionId}.json`);
                    let sessionString = megaUrl.replace('https://mega.nz/file/', '');
                    sessionString = "KERM-MD-V1~" + sessionString;
                    
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    await socket.sendMessage(userJid, { text: sessionString });
                    
                    // Nettoyer
                    await delay(1000);
                    await removeFile(sessionDir);
                    activeSessions.delete(sessionId);
                    await socket.end();
                    
                } catch (err) {
                    console.error(`Erreur upload session ${sessionId}:`, err);
                }
            }
        });
        
    } catch (err) {
        console.error(`Erreur génération code:`, err);
        res.status(503).json({ code: 'Service Unavailable', error: err.message });
        await removeFile(sessionDir);
    }
});

// Nettoyage automatique
setInterval(async () => {
    const now = Date.now();
    const EXPIRATION_TIME = 10 * 60 * 1000;
    
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.createdAt > EXPIRATION_TIME) {
            console.log(`Nettoyage session expirée: ${sessionId}`);
            if (session.socket) {
                await session.socket.end();
            }
            await removeFile(session.sessionDir);
            activeSessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);

export default router;
