const fs = require('fs');
const { execSync } = require('child_process');

// Create a simple SVG icon - a stylized "W" with connection nodes
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#4f46e5"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#818cf8"/>
      <stop offset="100%" style="stop-color:#6366f1"/>
    </linearGradient>
  </defs>
  
  <!-- Background rounded square -->
  <rect x="32" y="32" width="448" height="448" rx="96" fill="url(#bg)"/>
  
  <!-- W shape made of connected dots/nodes -->
  <g fill="#ffffff">
    <!-- Main W shape using lines -->
    <path d="M128 160 L176 352 L256 240 L336 352 L384 160" 
          stroke="#ffffff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    
    <!-- Connection nodes -->
    <circle cx="128" cy="160" r="24"/>
    <circle cx="176" cy="352" r="24"/>
    <circle cx="256" cy="240" r="24"/>
    <circle cx="336" cy="352" r="24"/>
    <circle cx="384" cy="160" r="24"/>
  </g>
  
  <!-- Small MCP-style connector dots -->
  <circle cx="420" cy="420" r="16" fill="#a5b4fc"/>
  <circle cx="92" cy="420" r="12" fill="#a5b4fc"/>
</svg>`;

fs.writeFileSync('icon.svg', svg);
console.log('SVG icon created');

// Check if we have sips (macOS built-in image tool)
try {
  // Use sips to convert - but we need a PNG first
  // Let's check for available tools
  console.log('Checking for conversion tools...');
  
  try {
    execSync('which convert', { encoding: 'utf-8' });
    console.log('ImageMagick found');
    
    // Generate all required sizes
    const sizes = [32, 128, 256, 512];
    sizes.forEach(size => {
      execSync(`convert -background none icon.svg -resize ${size}x${size} src-tauri/icons/${size}x${size}.png`);
      console.log(`Generated ${size}x${size}.png`);
    });
    
    // Create 128x128@2x (256px)
    execSync('cp src-tauri/icons/256x256.png src-tauri/icons/128x128@2x.png');
    console.log('Generated 128x128@2x.png');
    
    // Create icns for macOS
    execSync('convert icon.svg -resize 512x512 src-tauri/icons/icon.png');
    
    // Create ico for Windows
    execSync('convert icon.svg -resize 256x256 src-tauri/icons/icon.ico');
    console.log('Generated icon.ico');
    
    // For icns, we need iconutil on macOS
    execSync('mkdir -p icon.iconset');
    [16, 32, 64, 128, 256, 512].forEach(size => {
      execSync(`convert -background none icon.svg -resize ${size}x${size} icon.iconset/icon_${size}x${size}.png`);
      if (size <= 256) {
        execSync(`convert -background none icon.svg -resize ${size*2}x${size*2} icon.iconset/icon_${size}x${size}@2x.png`);
      }
    });
    execSync('iconutil -c icns icon.iconset -o src-tauri/icons/icon.icns');
    execSync('rm -rf icon.iconset');
    console.log('Generated icon.icns');
    
  } catch (e) {
    console.log('ImageMagick not found, trying alternative...');
    // Just note that icons need to be generated
    console.log('Please install ImageMagick: brew install imagemagick');
  }
} catch (e) {
  console.log('Error:', e.message);
}
