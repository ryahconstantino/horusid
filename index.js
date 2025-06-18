const puppeteer = require('puppeteer');
const readline = require('readline');

const PASSENGER_TYPE_CODE = "A1";
const LANGUAGE = "pt-BR";
const TARGET_API_BASE_URL = "https://one-api.satelitenorte.com.br/api/v2/search";


const dayNameMapping = {
    "Domingo": 0,
    "Segunda-feira": 1,
    "Terça-feira": 2,
    "Quarta-feira": 3,
    "Quinta-feira": 4,
    "Sexta-feira": 5,
    "Sábado": 6
};

/**
 * Formats a Date object into "YYYY-MM-DD" string.
 * @param {Date} date The date object to format.
 * @returns {string} The formatted date string.
 */
function formatDateToString(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Months are 0-indexed
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Extracts the day of the week string (e.g., "Quinta-feira") from a trip name.
 * Assumes the day is in parentheses at the end, like "(Quinta-feira)".
 * @param {string} tripName The name of the trip.
 * @returns {string|null} The day of the week string or null if not found/invalid.
 */
function getDayOfWeekFromString(tripName) {
    const match = tripName.match(/\(([^)]+)\)$/);
    if (match && match[1]) {
        const dayPart = match[1];
        if (dayNameMapping.hasOwnProperty(dayPart)) {
            return dayPart;
        }
    }
    console.warn(`[WARN] Could not extract a valid day of the week from trip name: "${tripName}"`);
    return null;
}

/**
 * Generates a specified number of future dates for a given day of the week, starting from the current date.
 * @param {string} targetDayName The name of the target day of the week (e.g., "Quinta-feira").
 * @param {number} count The number of future dates to generate.
 * @returns {string[]} An array of formatted date strings ("YYYY-MM-DD").
 */
function generateFutureDates(targetDayName, count = 4) {
    if (!dayNameMapping.hasOwnProperty(targetDayName)) {
        console.error(`[ERROR] Invalid target day name provided: ${targetDayName}`);
        return [];
    }

    const targetDayNumber = dayNameMapping[targetDayName];
    const futureDates = [];
    let currentDate = new Date();

    let daysUntilTarget = (targetDayNumber - currentDate.getDay() + 7) % 7;

    let nextTargetDate = new Date();
    nextTargetDate.setDate(currentDate.getDate() + daysUntilTarget);

    for (let i = 0; i < count; i++) {
        futureDates.push(formatDateToString(new Date(nextTargetDate)));
        nextTargetDate.setDate(nextTargetDate.getDate() + 7);
    }

    return futureDates;
}

async function fetchBusDataForDateWithPuppeteer(dateString, originCity, destinationCity) {
    const searchPageUrl = `https://viagem.satelitenorte.com.br/search/${originCity}/${destinationCity}/${dateString}/p/${PASSENGER_TYPE_CODE}/departures?lang=${LANGUAGE}`;
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        let capturedJsonData = null;

        const jsonCapturePromise = new Promise((resolve, reject) => {
            const responseTimeout = setTimeout(() => {
                if (!capturedJsonData) {
                    reject(new Error(`Timeout: Did not capture the target JSON response from ${TARGET_API_BASE_URL} within 45 seconds for ${dateString} (${originCity} -> ${destinationCity}). The page might have loaded, but the expected API call wasn't detected or completed in time.`));
                }
            }, 45000);

            page.on('response', async (response) => {
                const reqUrl = response.url();
                if (reqUrl.startsWith(TARGET_API_BASE_URL) && reqUrl.includes('?type=bus')) {
                    try {
                        const jsonData = await response.json();
                        if (jsonData && jsonData.trips && Array.isArray(jsonData.trips)) {
                            capturedJsonData = jsonData;
                            clearTimeout(responseTimeout);
                            resolve(jsonData);
                        }
                    } catch (e) {
                        // Ignore JSON parsing errors here, let timeout handle if no valid data
                    }
                }
            });
        });

        try {
            await page.goto(searchPageUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        } catch (e) {
            throw e; // Rethrow to be caught by the outer try-catch
        }

        return await jsonCapturePromise;

    } catch (error) {
        console.error(`[ERROR] Não foi possível procurar frotas no dia ${dateString}`);
        return null;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error(`[ERROR] Não foi possível fechar o navegador`);
            }
        }
    }
}

function processAndFilterTrips(jsonData) {
    if (!jsonData || typeof jsonData !== 'object') {
        console.warn("[WARN] processAndFilterTrips: jsonData is null or not an object.");
        return [];
    }
    if (!jsonData.trips || !Array.isArray(jsonData.trips)) {
        console.warn(`[WARN] processAndFilterTrips: No trip data or malformed trips array for ${jsonData.departs || 'unknown date'}.`);
        return [];
    }

    const searchDate = jsonData.departs;
    const conventionalTrips = [];

    jsonData.trips.forEach(trip => {
        if (trip.service === "CONVENCIONAL") {
            let generalPrice = trip.pricing.total;
            let freePassDetails = null;
            let disadvantagedYouthDetails = null; // Para 100% de desconto
            let disadvantagedYouthHalfDetails = null; // Para 50% de desconto

            if (trip.passenger_types && Array.isArray(trip.passenger_types)) {
                const generalPt = trip.passenger_types.find(pt => pt.type === "general");
                if (generalPt && generalPt.total !== undefined) {
                    generalPrice = parseFloat(generalPt.total);
                }

                const freePassPt = trip.passenger_types.find(pt => pt.type === "free_pass" && parseFloat(pt.total) === 0.0);
                if (freePassPt) {
                    freePassDetails = {
                        price: 0.0,
                        availability: freePassPt.availability,
                        type: "Gratuidade (Idoso/PCD)" // Nome mais descritivo
                    };
                }

                // Extrair Jovem de Baixa Renda 100% (disadvantaged_youth)
                const disadvantagedYouthPt = trip.passenger_types.find(pt => pt.type === "disadvantaged_youth");
                if (disadvantagedYouthPt) {
                    disadvantagedYouthDetails = {
                        price: parseFloat(disadvantagedYouthPt.total), // Geralmente é um valor baixo referente a taxas, ou 0.0
                        availability: disadvantagedYouthPt.availability,
                        type: "Jovem Baixa Renda 100%"
                    };
                }

                // Extrair Jovem de Baixa Renda 50% (disadvantaged_youth_half)
                const disadvantagedYouthHalfPt = trip.passenger_types.find(pt => pt.type === "disadvantaged_youth_half");
                if (disadvantagedYouthHalfPt) {
                    disadvantagedYouthHalfDetails = {
                        price: parseFloat(disadvantagedYouthHalfPt.total),
                        availability: disadvantagedYouthHalfPt.availability,
                        type: "Jovem Baixa Renda 50%"
                    };
                }
            }

            conventionalTrips.push({
                date: searchDate,
                serviceType: trip.service,
                departureTimestamp: trip.departure,
                arrivalTimestamp: trip.arrival,
                price: generalPrice,
                freePassInfo: freePassDetails,
                disadvantagedYouthInfo: disadvantagedYouthDetails,
                disadvantagedYouthHalfInfo: disadvantagedYouthHalfDetails
            });
        }
    });
    return conventionalTrips;
}

function printTripDetails(trips, dateSearched, tripName) {
    if (trips.length === 0) {
        console.log(`[INFO] Não foram encontrados ônibus para ${tripName} em ${formatDateToBrazilian(dateSearched)}.`);
        return;
    }

    console.log(`\n--- Frota disponível para ${tripName} no dia ${formatDateToBrazilian(dateSearched)} ---`);
    trips.forEach((trip, index) => {
        const departureDateTime = trip.departureTimestamp ? new Date(trip.departureTimestamp) : null;
        const arrivalDateTime = trip.arrivalTimestamp ? new Date(trip.arrivalTimestamp) : null;

        console.log(`\n  Ônibus ${index + 1}:`);
        console.log(`    Serviço: ${trip.serviceType}`);
        if (departureDateTime) {
            console.log(`    Embarque: ${departureDateTime.toLocaleDateString('pt-BR')} ${departureDateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
        } else {
            console.log(`    Embarque: Não disponível`);
        }
        if (arrivalDateTime) {
            console.log(`    Chegada:  ${arrivalDateTime.toLocaleDateString('pt-BR')} ${arrivalDateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
        } else {
            console.log(`    Chegada:  Não disponível`);
        }

        console.log(`    Valor (Geral): R$${trip.price.toFixed(2)}`);

        if (trip.disadvantagedYouthInfo) {
            console.log(`      ${trip.disadvantagedYouthInfo.type}: ${trip.disadvantagedYouthInfo.availability} vagas`);
            console.log(`      Valor: R$${trip.disadvantagedYouthInfo.price.toFixed(2)}`);
        }

        if (trip.disadvantagedYouthHalfInfo) {
            console.log(`      ${trip.disadvantagedYouthHalfInfo.type}: ${trip.disadvantagedYouthHalfInfo.availability} vagas`);
            console.log(`      Valor: R$${trip.disadvantagedYouthHalfInfo.price.toFixed(2)}`);
        }
    });
    console.log("-------------------------------------------------");
}

function promptUserForTripSelection(tripOptions) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve, reject) => {
        console.log("\nSelecione a viagem desejada:");
        tripOptions.forEach((option, index) => {
            console.log(`${index + 1}. ${option.name}`);
        });
        console.log("0. Sair");

        rl.question("Digite o número da opção: ", (answer) => {
            rl.close();
            const choice = parseInt(answer, 10);
            if (isNaN(choice)) {
                reject(new Error("Opção inválida. Por favor, digite um número."));
            } else if (choice === 0) {
                resolve(null);
            } else if (choice > 0 && choice <= tripOptions.length) {
                resolve(tripOptions[choice - 1]);
            }
        });
    });
}

function formatDateToBrazilian(dateString) {
    if (!dateString || typeof dateString !== 'string') {
        return dateString;
    }
    const parts = dateString.split('-');
    if (parts.length === 3) {
        const year = parts[0];
        const month = parts[1];
        const day = parts[2];
        return `${day}/${month}/${year}`;
    }
    return dateString;
}

async function main() {
    const tripOptionsConfig = [
        { name: "São Paulo > Goiania (Quinta-feira)", origin: "sao-paulo", destination: "goiania" },
        { name: "Goiania > Sao Luis (Sábado)", origin: "goiania", destination: "sao-luis" },
        { name: "São Luis > Goiania (Sábado)", origin: "sao-luis", destination: "goiania" },
        { name: "Goiania > São Paulo (Quinta-feira)", origin: "goiania", destination: "sao-paulo" }
    ];

    const tripSelections = tripOptionsConfig.map(config => {
        const dayOfWeekName = getDayOfWeekFromString(config.name);
        let dates = [];
        if (dayOfWeekName) {
            dates = generateFutureDates(dayOfWeekName, 4);
        } else {
            console.warn(`[WARN] Dates will not be generated for trip "${config.name}" as day of week could not be determined.`);
        }
        return {
            ...config,
            dates: dates
        };
    });

    try {
        const selectedTrip = await promptUserForTripSelection(tripSelections);

        if (selectedTrip) {
            console.log(`\n[INFO] Iniciando busca para: ${selectedTrip.name}`);

            if (!selectedTrip.dates || selectedTrip.dates.length === 0) {
                console.log(`[INFO] Nenhuma data calculada para a viagem selecionada: ${selectedTrip.name}. Verifique a configuração do nome da viagem.`);
            } else {
                console.log(`[INFO] Datas que serão pesquisadas: ${selectedTrip.dates.join(', ')}`);
                for (const dateStr of selectedTrip.dates) {
                    try {
                        const jsonData = await fetchBusDataForDateWithPuppeteer(dateStr, selectedTrip.origin, selectedTrip.destination);
                        if (jsonData) {
                            const conventionalTrips = processAndFilterTrips(jsonData);
                            printTripDetails(conventionalTrips, dateStr, selectedTrip.name);
                        } else {
                            console.log(`[INFO] Não foi possível processar as rotas ${selectedTrip.name} em ${dateStr}.`);
                        }
                    } catch (error) {
                        console.error(`[ERROR] Erro critico ao buscar rotas de ${selectedTrip.name} em ${dateStr}: ${error.message}`);
                        if (error.stack) console.error(error.stack);
                    }
                }
            }
        } else {
            console.log("[INFO] Nenhuma viagem selecionada. Saindo.");
        }
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
    } finally {
        console.log("\n[INFO] Busca finalizada.");
    }
}

main().catch(err => {
    console.error("[FATAL_ERROR] Erro na execução:", err);
});
