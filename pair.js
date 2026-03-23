import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';
import { upload } from './mega.js';

const router = express.Router();

// Configuration
const SESSION_TIMEOUT = 30000; // 30 secondes
const CLEANUP_DELAY = 2000;
const MAX_RETRIES = 3;

// Stockage des sessions actives
const activeSessions = new Map();

// Fonction utilitaire sécurisée pour supprimer un fichier
async function removeFile(filePath) {
    try {
        await fs.rm(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`Erreur lors de la suppression de ${filePath}:`, error.message);
        return false;
    }
}

// Génération d'ID sécurisé
function generateSecureId(length = 10) {
    return crypto.randomBytes(length).toString('hex');
}

// Validation du numéro de téléphone
function validatePhoneNumber(number) {
    if (!number || typeof number !== 'string') {
        return null;
    }
    const cleaned = number.replace(/[^0-9]/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null;
    }
    return cleaned;
}

// Nettoyage des event listeners
function cleanupEventListeners(socket, events) {
    events.forEach(event => {
        socket.ev.removeAllListeners(event);
    });
}

// Création de session avec timeout
async function createSessionWithTimeout(sessionId, phoneNumber, timeout) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Session timeout'));
        }, timeout);

        initiateSession(sessionId, phoneNumber)
            .then(result => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

// Fonction principale de création de session
async function initiateSession(sessionId, phoneNumber) {
    const sessionDir = path.join('./sessions', sessionId);
    let socket = null;
    let retryCount = 0;

    async function createSocket() {
        try {
            // Création du dossier de session
            await fs.mkdir(sessionDir, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            
            socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                defaultQueryTimeoutMs: 15000,
                keepAliveIntervalMs: 10000,
            });

            // Stocker la socket dans la session active
            activeSessions.set(sessionId, {
                socket,
                saveCreds,
                createdAt: Date.now(),
                phoneNumber
            });

            return { socket, saveCreds };
        } catch (error) {
            console.error(`Erreur création socket (${sessionId}):`, error.message);
            throw error;
        }
    }

    async function handleConnection(socket, saveCreds) {
        return new Promise((resolve, reject) => {
            const connectionHandler = async (update) => {
                const { connection, lastDisconnect } = update;

                try {
                    if (connection === "open") {
                        console.log(`Session ${sessionId} connectée avec succès`);
                        
                        // Attendre un peu que la session soit stabilisée
                        await delay(3000);
                        
                        // Lire le fichier creds
                        const credsPath = path.join(sessionDir, 'creds.json');
                        const credsContent = await fs.readFile(credsPath);
                        
                        // Upload vers Mega
                        const megaUrl = await upload(credsContent, `${sessionId}.json`);
                        let sessionString = megaUrl.replace('https://mega.nz/file/', '');
                        sessionString = `KERM-MD-V1~${sessionString}`;
                        
                        // Envoyer la session au numéro
                        const userJid = jidNormalizedUser(`${phoneNumber}@s.whatsapp.net`);
                        await socket.sendMessage(userJid, { 
                            text: sessionString,
                            ephemeralExpiration: 86400 // Auto-suppression après 24h
                        });
                        
                        // Envoyer le message de confirmation
                        await socket.sendMessage(userJid, { 
                            text: '✅ *Session générée avec succès!*\n\n' +
                                  '⚠️ *Important:* Ne partagez jamais cette session avec personne.\n\n' +
                                  '📱 *Bot:* KERM MD V1\n' +
                                  '🔗 *Channel:* https://whatsapp.com/channel/0029Vafn6hc7DAX3fzsKtn45\n\n' +
                                  '©️ KGTECH',
                            ephemeralExpiration: 86400
                        });
                        
                        // Nettoyer la session après utilisation
                        await delay(CLEANUP_DELAY);
                        await cleanupSession(sessionId);
                        
                        resolve({ success: true, sessionString });
                        
                    } else if (connection === 'close') {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        
                        if (statusCode !== 401 && retryCount < MAX_RETRIES) {
                            retryCount++;
                            console.log(`Session ${sessionId}: Reconnexion tentative ${retryCount}/${MAX_RETRIES}`);
                            await delay(5000);
                            const { socket: newSocket, saveCreds: newSaveCreds } = await createSocket();
                            await handleConnection(newSocket, newSaveCreds);
                        } else {
                            reject(new Error(`Session fermée: ${lastDisconnect?.error?.message || 'Unknown error'}`));
                        }
                    }
                } catch (error) {
                    console.error(`Erreur handler session ${sessionId}:`, error);
                    reject(error);
                }
            };

            // Gestion du code de pairage
            if (!socket.authState.creds.registered) {
                socket.requestPairingCode(phoneNumber)
                    .then(code => {
                        console.log(`Code de pairage pour ${phoneNumber}:`, code);
                        // Ici vous pourriez envoyer le code via un autre canal
                    })
                    .catch(error => {
                        console.error(`Erreur pairage ${sessionId}:`, error);
                        reject(error);
                    });
            }

            socket.ev.on('connection.update', connectionHandler);
            socket.ev.on('creds.update', saveCreds);
            
            // Stocker les handlers pour nettoyage
            activeSessions.set(sessionId, {
                ...activeSessions.get(sessionId),
                handlers: { connectionHandler }
            });
        });
    }

    try {
        const { socket: newSocket, saveCreds: newSaveCreds } = await createSocket();
        return await handleConnection(newSocket, newSaveCreds);
    } catch (error) {
        await cleanupSession(sessionId);
        throw error;
    }
}

// Nettoyage d'une session
async function cleanupSession(sessionId) {
    const session = activeSessions.get(sessionId);
    
    if (session) {
        // Nettoyer les event listeners
        if (session.socket && session.handlers) {
            cleanupEventListeners(session.socket, ['connection.update', 'creds.update']);
        }
        
        // Fermer la connexion
        if (session.socket && session.socket.end) {
            await session.socket.end();
        }
        
        // Supprimer les fichiers
        const sessionDir = path.join('./sessions', sessionId);
        await removeFile(sessionDir);
        
        // Supprimer de la map active
        activeSessions.delete(sessionId);
        
        console.log(`Session ${sessionId} nettoyée avec succès`);
    }
}

// Route principale
router.post('/generate-session', async (req, res) => {
    const { number } = req.body;
    let sessionId = null;
    
    try {
        // Validation du numéro
        const validatedNumber = validatePhoneNumber(number);
        if (!validatedNumber) {
            return res.status(400).json({ 
                error: 'Numéro de téléphone invalide',
                format: 'Format attendu: +1234567890 ou 1234567890'
            });
        }
        
        // Générer un ID de session unique
        sessionId = generateSecureId();
        
        console.log(`Démarrage de la session ${sessionId} pour ${validatedNumber}`);
        
        // Créer la session avec timeout
        const result = await createSessionWithTimeout(
            sessionId, 
            validatedNumber, 
            SESSION_TIMEOUT
        );
        
        // Réponse succès
        res.status(200).json({
            success: true,
            message: 'Session générée et envoyée avec succès',
            sessionId: sessionId,
            targetNumber: validatedNumber
        });
        
    } catch (error) {
        console.error(`Erreur génération session ${sessionId || 'unknown'}:`, error);
        
        // Nettoyer en cas d'erreur
        if (sessionId) {
            await cleanupSession(sessionId);
        }
        
        // Réponse erreur
        res.status(500).json({
            success: false,
            error: 'Échec de la génération de session',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Route pour vérifier l'état d'une session
router.get('/session-status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            exists: false,
            message: 'Session non trouvée ou déjà nettoyée'
        });
    }
    
    res.status(200).json({
        exists: true,
        createdAt: session.createdAt,
        phoneNumber: session.phoneNumber,
        isConnected: session.socket?.user ? true : false
    });
});

// Route pour nettoyer manuellement une session
router.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    try {
        await cleanupSession(sessionId);
        res.status(200).json({
            success: true,
            message: 'Session supprimée avec succès'
        });
    } catch (error) {
        console.error(`Erreur nettoyage session ${sessionId}:`, error);
        res.status(500).json({
            success: false,
            error: 'Échec du nettoyage de la session'
        });
    }
});

// Middleware de nettoyage périodique des sessions expirées
setInterval(async () => {
    const now = Date.now();
    const EXPIRATION_TIME = 5 * 60 * 1000; // 5 minutes
    
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.createdAt > EXPIRATION_TIME) {
            console.log(`Nettoyage session expirée: ${sessionId}`);
            await cleanupSession(sessionId);
        }
    }
}, 60000); // Vérification toutes les minutes

export default router;
