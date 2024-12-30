#!/bin/bash
if [ "$EUID" -eq 0 ]; then
    echo "This script should not be run with sudo."
    exit 1
fi

# CD into the directory of this script
cd "$(dirname "$0")" || exit 1

# Auto-detect if no arguments provided
if [ $# -eq 0 ]; then
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="mac"
    elif grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
        platform="win"
    else
        echo "Unsupported platform detected: $OSTYPE"
        exit 1
    fi

    # Detect architecture
    machine=$(uname -m)
    case "$machine" in
        arm64|aarch64) architecture="arm" ;;
        x86_64|amd64) architecture="x64" ;;
        *) 
            echo "Unsupported architecture detected: $machine"
            exit 1
            ;;
    esac

    # Get Windows username if on Windows
    if [ "$platform" == "win" ]; then
        windows_user=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
    fi

    echo "--- Detected platform: $platform"
    echo "Detected architecture: $architecture"
    [ "$platform" == "win" ] && echo "Detected Windows user: $windows_user"

# Handle manual arguments
elif [ $# -ne 3 ] && [ $# -ne 2 ]; then
    echo "Usage for Windows: $0 <platform> <architecture> <windows_user>"
    echo "Example: $0 win x64 selli"
    echo "Usage for MacOS: $0 <platform> <architecture>"
    echo "Example: $0 mac arm"
    exit 1
else
    if [ $# -eq 2 ]; then
        platform=$1
        architecture=$2
        windows_user=""
    else
        platform=$1
        architecture=$2
        windows_user=$3
    fi
fi



if [ "$platform" != "win" ] && [ "$platform" != "mac" ]; then
    echo "Invalid platform. Please provide 'win' or 'mac' as the first argument."
    exit 1
fi

if [ "$architecture" != "arm" ] && [ "$architecture" != "x64" ]; then
    echo "Invalid architecture. Please provide 'arm' or 'x64' as the second argument."
    exit 1
fi


if [ "$platform" == "win" ]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # Load nvm

    nvm install --latest-npm

    npm install -g npm-check-updates
fi


script_start_time=$(date +%s)



echo ""
echo ":: Updating all NPM packages"
echo ""

bash update_packages_latest.sh



echo ""
echo ":: Building the app"
echo ""

npm run package-$platform-$architecture



end_time=$(date +%s)
execution_time=$((end_time - script_start_time))
echo ""
echo ":: Build app execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""

copy_start_time=$(date +%s)




if [ "$platform" == "win" ]; then
    echo ""
    echo ":: Copying the app to the Windows 11 desktop"
    echo ""

    /mnt/c/Windows/System32/taskkill.exe /F /IM "InstantCognition.exe" &> /dev/null
    sleep 1

    mkdir -p /mnt/c/Users/$windows_user/OneDrive/Desktop/InstantCognition/

    cp -r builds/$platform-$architecture/* /mnt/c/Users/$windows_user/OneDrive/Desktop/InstantCognition/

    subfolder_architecture=$(if [[ "$architecture" == "arm" ]]; then echo "arm64"; else echo "x64"; fi)
    /mnt/c/Users/$windows_user/OneDrive/Desktop/InstantCognition/InstantCognition-win32-$subfolder_architecture/InstantCognition.exe &> /dev/null &

else # platform == "mac"
    echo ""
    echo ":: Copying the app to the MacOS Applications folder"
    echo ""

    osascript -e 'quit app "InstantCognition.app"'

    # set subfolder to arm64 if $architecture is 'arm', else set it to x64
    subfolder_architecture=$(if [[ "$architecture" == "arm" ]]; then echo "arm64"; else echo "x64"; fi)
    cp -r builds/mac-$architecture/InstantCognition-darwin-$subfolder_architecture/InstantCognition.app ~/Applications/

    open ~/Applications/InstantCognition.app
fi



end_time=$(date +%s)
execution_time=$((end_time - copy_start_time))
echo ""
echo ":: Copy app execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""



execution_time=$((end_time - script_start_time))
# Print the execution time in an aesthetically pleasing way
echo ""
echo ""
echo ":: Full script execution time: $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds."
echo ""
echo "" 