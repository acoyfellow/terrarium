const hexadecimalWidth = 8;
const formatHash = (value) => (value >>> 0).toString(16).padStart(hexadecimalWidth, "0");
export const fingerprint = (task) => {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    let third = 0x85ebca6b;
    for (let index = 0; index < task.length; index += 1) {
        const character = task.charCodeAt(index);
        first = Math.imul(first ^ character, 0x01000193);
        second = Math.imul(second ^ character ^ index, 0x85ebca6b);
        third = Math.imul(third ^ character ^ first, 0xc2b2ae35);
    }
    return `${formatHash(first)}${formatHash(second)}${formatHash(third)}`;
};
